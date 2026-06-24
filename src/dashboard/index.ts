import crypto from "node:crypto";
import fsSync from "node:fs";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Request, Response, Router } from "express";
import { ACCESS_TOKEN_TTL_SECONDS } from "../auth/store.js";
import { AppConfig } from "../config.js";
import { Journal, JournalEntry } from "../journal.js";
import { browserSessionDashboardSummaries, closeBrowserSessionForDashboard } from "../tools/browser.js";
import { TOOL_DEFINITIONS } from "../tools/registry.js";

type DashboardRuntime = {
  config: AppConfig;
  journal: Journal;
  recoveredOperations: string[];
};

type ActivityItem = {
  cwd?: string;
  durationMs?: number;
  error?: string;
  human: string;
  operationId?: string;
  outcome?: string;
  phase?: string;
  risk: "low" | "medium" | "high";
  timestamp: string;
  tool: string;
};

type WarningItem = {
  message: string;
  risk: "medium" | "high";
  timestamp: string;
  tool: string;
};

type DashboardCheck = {
  detail: string;
  name: string;
  ok: boolean;
  severity: "info" | "warning" | "critical";
};

type RecoveryAction = {
  action?: string;
  detail: string;
  label: string;
  priority: "low" | "medium" | "high";
  title: string;
};

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
const CURRENT_RISK_WINDOW_MS = 15 * 60 * 1000;
const CLOUDFLARED_EXE =
  process.env.CLOUDFLARED_EXE || path.join(os.homedir(), "Documents", "cloudflared", "cloudflared.exe");
const CLOUDFLARED_CONFIG = process.env.CLOUDFLARED_CONFIG || path.join(os.homedir(), ".cloudflared", "config.yml");
const TUNNEL_NAME = process.env.CLOUDFLARE_TUNNEL_NAME || "chatgpt-local-agent-mcp";
const LIVE_MONITOR_SCRIPT = path.join(process.cwd(), "scripts", "live-monitor.ps1");
const DASHBOARD_CSRF_TOKEN = crypto.randomBytes(32).toString("base64url");

function dashboardHtml(csrfToken: string): string {
  return String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="dashboard-csrf-token" content="${csrfToken}">
  <title>chatgpt-local-agent-mcp-control-center</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #0e1116;
      --panel: #171c23;
      --panel-2: #11161d;
      --ink: #e7edf4;
      --muted: #9aa8b7;
      --line: #2b3542;
      --good: #4fd18b;
      --warn: #f2b84b;
      --bad: #ff6b5f;
      --info: #72b7ff;
      --soft: #202833;
      --shadow: 0 1px 2px rgba(0, 0, 0, .35);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--ink);
      font: 14px/1.45 "Segoe UI", system-ui, sans-serif;
    }
    header {
      position: sticky;
      top: 0;
      z-index: 2;
      background: rgba(14, 17, 22, .96);
      border-bottom: 1px solid var(--line);
      backdrop-filter: blur(8px);
    }
    .top {
      display: flex;
      align-items: center;
      gap: 18px;
      max-width: 1420px;
      margin: 0 auto;
      padding: 16px 22px;
    }
    h1 { margin: 0; font-size: 22px; font-weight: 650; letter-spacing: 0; }
    .subtitle { color: var(--muted); margin-top: 2px; }
    .status-pill {
      margin-left: auto;
      padding: 7px 11px;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: var(--panel);
      font-weight: 600;
    }
    .status-pill.good { color: var(--good); border-color: #a8d8bc; background: #eefaf3; }
    .status-pill.warn { color: var(--warn); border-color: #ead0a6; background: #fff8ea; }
    .status-pill.bad { color: var(--bad); border-color: #f1b6af; background: #fff1ef; }
    main { max-width: 1420px; margin: 0 auto; padding: 18px 22px 34px; }
    nav {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-bottom: 16px;
    }
    nav button, .action-row button {
      border: 1px solid var(--line);
      border-radius: 6px;
      background: var(--panel);
      color: var(--ink);
      padding: 8px 11px;
      cursor: pointer;
      font: inherit;
      box-shadow: var(--shadow);
    }
    nav button:hover, .action-row button:hover { border-color: #4f6074; background: #202833; }
    nav button.active { border-color: #4587b6; background: #10283b; color: #bfe5ff; }
    .action-row button.danger { border-color: #6b2f34; color: #ffc7c3; }
    .action-row button.primary { border-color: #2d638d; color: #bfe5ff; }
    .grid {
      display: grid;
      grid-template-columns: repeat(12, 1fr);
      gap: 14px;
    }
    section { display: none; }
    section.active { display: block; }
    .card {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      box-shadow: var(--shadow);
      padding: 15px;
      min-width: 0;
    }
    .span-3 { grid-column: span 3; }
    .span-4 { grid-column: span 4; }
    .span-5 { grid-column: span 5; }
    .span-6 { grid-column: span 6; }
    .span-7 { grid-column: span 7; }
    .span-8 { grid-column: span 8; }
    .span-12 { grid-column: span 12; }
    .gold-major { grid-column: span 7; }
    .gold-minor { grid-column: span 5; }
    .gold-wide { grid-column: span 8; }
    .gold-narrow { grid-column: span 4; }
    h2, h3 { margin: 0 0 10px; letter-spacing: 0; }
    h2 { font-size: 19px; }
    h3 { font-size: 15px; color: #d6e1ed; }
    .metric { font-size: 28px; font-weight: 700; margin: 4px 0; }
    .muted { color: var(--muted); }
    .kv { display: grid; grid-template-columns: 170px 1fr; gap: 7px 12px; }
    .kv div:nth-child(odd) { color: var(--muted); }
    .list { display: grid; gap: 8px; }
    .event {
      border: 1px solid var(--line);
      border-radius: 7px;
      padding: 10px;
      background: var(--panel-2);
    }
    .event.high { border-left: 5px solid var(--bad); }
    .event.medium { border-left: 5px solid var(--warn); }
    .event.low { border-left: 5px solid var(--info); }
    .event .meta { color: var(--muted); font-size: 12px; margin-top: 4px; }
    code, pre {
      font-family: Consolas, "SFMono-Regular", monospace;
      font-size: 12px;
    }
    pre {
      white-space: pre-wrap;
      overflow: auto;
      max-height: 520px;
      margin: 0;
      background: #090c10;
      color: #e8f0f6;
      border-radius: 7px;
      padding: 12px;
    }
    .good-text { color: var(--good); }
    .warn-text { color: var(--warn); }
    .bad-text { color: var(--bad); }
    .action-row { display: flex; gap: 8px; flex-wrap: wrap; }
    .safety {
      border-top: 1px solid var(--line);
      background: #0b0f14;
    }
    .safety-inner {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      max-width: 1420px;
      margin: 0 auto;
      padding: 9px 22px;
    }
    .chip {
      align-items: center;
      border: 1px solid var(--line);
      border-radius: 999px;
      display: inline-flex;
      gap: 7px;
      padding: 5px 9px;
      background: var(--panel-2);
      color: var(--muted);
      font-size: 12px;
      white-space: nowrap;
    }
    .chip.good { border-color: #245f42; color: var(--good); }
    .chip.warn { border-color: #755b24; color: var(--warn); }
    .chip.bad { border-color: #733630; color: var(--bad); }
    .next-action {
      border-left: 5px solid var(--info);
      min-height: 135px;
    }
    .next-action.high { border-left-color: var(--bad); }
    .next-action.medium { border-left-color: var(--warn); }
    .next-action.low { border-left-color: var(--good); }
    .toolbar {
      align-items: center;
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin: 0 0 12px;
    }
    .toolbar select {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 6px;
      color: var(--ink);
      font: inherit;
      padding: 8px 10px;
    }
    .drawer {
      border: 1px solid var(--line);
      border-radius: 8px;
      margin-top: 12px;
      padding: 12px;
      background: #0b0f14;
    }
    .hidden { display: none; }
    @media (max-width: 980px) {
      .span-3, .span-4, .span-5, .span-6, .span-7, .span-8,
      .gold-major, .gold-minor, .gold-wide, .gold-narrow { grid-column: span 12; }
      .top { align-items: flex-start; flex-direction: column; }
      .status-pill { margin-left: 0; }
      .kv { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <header>
    <div class="top">
      <div>
        <h1>chatgpt-local-agent-mcp</h1>
        <div class="subtitle">Local control center for your full-access ChatGPT workstation bridge.</div>
      </div>
      <div id="overallStatus" class="status-pill warn">Checking...</div>
    </div>
    <div class="safety"><div id="safetyBanner" class="safety-inner"></div></div>
  </header>
  <main>
    <nav id="tabs">
      <button data-tab="overview" class="active">Overview</button>
      <button data-tab="status">Status</button>
      <button data-tab="activity">GPT Activity</button>
      <button data-tab="security">Security</button>
      <button data-tab="files">Files & Changes</button>
      <button data-tab="browser">Browser & Desktop</button>
      <button data-tab="processes">Processes</button>
      <button data-tab="tests">Tests</button>
      <button data-tab="config">Configuration</button>
      <button data-tab="maintenance">Maintenance</button>
      <button data-tab="auth">Connector/Auth</button>
      <button data-tab="sessions">Browser Sessions</button>
      <button data-tab="monitor">Live Monitor</button>
      <button data-tab="cloudflare">Cloudflare</button>
      <button data-tab="tools">Tools & Scopes</button>
      <button data-tab="artifacts">Artifacts</button>
      <button data-tab="journal">Journal Explorer</button>
    </nav>

    <section id="overview" class="active">
      <div class="grid">
        <div id="nextActionCard" class="card next-action gold-minor"><h2>Next Action</h2><div id="nextAction"></div></div>
        <div class="card gold-major"><h2>System At A Glance</h2><div id="overviewKv" class="kv"></div><div class="action-row" style="margin-top:12px"><button id="overviewRefresh">Refresh</button><button id="copyDebugBundle">Copy Debug Bundle</button><button id="copyOverviewMcpUrl">Copy MCP URL</button></div></div>
        <div class="card span-4"><h2>Configuration</h2><div id="overviewConfig" class="list"></div></div>
        <div class="card span-4"><h2>Smoke Tests</h2><div id="overviewSmoke" class="list"></div></div>
        <div class="card span-4"><h2>Dashboard Health</h2><div id="dashboardHealth" class="kv"></div></div>
      </div>
    </section>

    <section id="status">
      <div class="grid">
        <div class="card span-3"><h3>Local Server</h3><div id="localMetric" class="metric">...</div><div id="localDetail" class="muted"></div></div>
        <div class="card span-3"><h3>Public Endpoint</h3><div id="publicMetric" class="metric">...</div><div id="publicDetail" class="muted"></div></div>
        <div class="card span-3"><h3>Auth</h3><div id="authMetric" class="metric">...</div><div id="authDetail" class="muted"></div></div>
        <div class="card span-3"><h3>Current Risk</h3><div id="riskMetric" class="metric">...</div><div id="riskDetail" class="muted"></div></div>
        <div class="card gold-wide">
          <h2>Right Now</h2>
          <div id="nowKv" class="kv"></div>
        </div>
        <div class="card gold-narrow">
          <h2>Actions</h2>
          <div class="action-row">
            <button id="refreshNow">Refresh</button>
            <button id="copyStatus">Copy Status</button>
            <button id="copyMcpUrl">Copy MCP URL</button>
          </div>
          <p class="muted">Local-only controls. If the local server is stopped, use the fallback app to start it again.</p>
        </div>
      </div>
    </section>

    <section id="activity"><div class="grid"><div class="card span-12"><h2>Recent GPT Activity</h2><div class="toolbar"><select id="activityRisk"><option value="all">All risk</option><option value="warnings">Warnings only</option><option value="high">High risk</option><option value="errors">Errors</option></select><select id="activityCategory"><option value="all">All tools</option><option value="filesystem">Filesystem</option><option value="browser">Browser</option><option value="desktop">Desktop/Screen</option><option value="process">Process/Shell</option><option value="git">Git</option></select><button id="copyActivitySummary">Copy Summary</button></div><div id="activityList" class="list"></div></div></div></section>
    <section id="security"><div class="grid"><div class="card gold-minor"><h2>Exposure</h2><div id="securityExposure" class="kv"></div></div><div class="card gold-major"><h2>Recent Warnings</h2><div id="warningList" class="list"></div></div></div></section>
    <section id="files"><div class="grid"><div class="card gold-major"><h2>File Activity</h2><div id="fileActivity" class="list"></div></div><div class="card gold-minor"><h2>Backups</h2><div id="backupInfo" class="kv"></div></div></div></section>
    <section id="browser"><div class="grid"><div class="card gold-major"><h2>Browser Surfaces</h2><div id="browserInfo" class="kv"></div></div><div class="card gold-minor"><h2>Desktop & Screen</h2><div id="desktopInfo" class="kv"></div></div></div></section>
    <section id="processes"><div class="grid"><div class="card gold-minor"><h2>Server & Tunnel</h2><div id="processInfo" class="kv"></div><div class="action-row" style="margin-top:12px"><button id="startTunnel" class="primary">Start Tunnel</button><button id="stopTunnel">Stop Tunnel</button><button id="restartTunnel">Restart Tunnel</button><button id="restartServer" class="danger">Restart Server</button><button id="stopServer" class="danger">Stop Server</button></div><p id="controlResult" class="muted"></p></div><div class="card gold-major"><h2>Log Tail</h2><pre id="serverLog">Loading...</pre></div></div></section>
    <section id="tests"><div class="grid"><div class="card gold-minor"><h2>Quick Tests</h2><div class="action-row"><button id="runTests">Run Local Checks</button></div><p class="muted">Checks local health, public health, metadata, and journal accessibility.</p></div><div class="card gold-major"><h2>Result</h2><div id="testResult" class="list"></div></div></div></section>
    <section id="config"><div class="grid"><div class="card gold-major"><h2>Human Configuration</h2><div id="configInfo" class="kv"></div></div><div class="card gold-minor"><h2>Workspace Profiles</h2><div id="profiles" class="list"></div></div></div></section>
    <section id="maintenance"><div class="grid"><div class="card gold-minor"><h2>Maintenance</h2><div id="maintenanceInfo" class="kv"></div><div class="action-row" style="margin-top:12px"><button id="copyBrief">Copy Agent Brief</button><button id="toggleRaw">Show Details</button></div></div><div class="card gold-major"><h2>Technical Detail</h2><pre id="rawDetail" class="hidden"></pre></div></div></section>
    <section id="auth"><div class="grid"><div class="card gold-major"><h2>Connector/Auth</h2><div id="authInfo" class="kv"></div></div><div class="card gold-minor"><h2>Reconnect Guardrail</h2><pre id="authNote">Loading...</pre></div></div></section>
    <section id="sessions"><div class="grid"><div class="card span-12"><h2>Browser Sessions</h2><div class="action-row" style="margin-bottom:12px"><button id="refreshSessions">Refresh Sessions</button></div><div id="sessionList" class="list"></div></div></div></section>
    <section id="monitor"><div class="grid"><div class="card gold-minor"><h2>Live Monitor</h2><div id="monitorInfo" class="kv"></div><div class="action-row" style="margin-top:12px"><button id="startMonitor" class="primary">Start Monitor</button><button id="stopMonitor" class="danger">Stop Monitor</button></div><p id="monitorResult" class="muted"></p></div><div class="card gold-major"><h2>Monitor Warnings</h2><div id="monitorWarnings" class="list"></div></div></div></section>
    <section id="cloudflare"><div class="grid"><div class="card gold-minor"><h2>Cloudflare Tunnel</h2><div id="cloudflareInfo" class="kv"></div><div class="action-row" style="margin-top:12px"><button id="openCloudflare">Open Cloudflare</button></div></div><div class="card gold-major"><h2>Cloudflared Logs</h2><pre id="cloudflareLogs">Loading...</pre></div></div></section>
    <section id="tools"><div class="grid"><div class="card span-12"><h2>Tools & Scopes</h2><div id="toolList" class="list"></div></div></div></section>
    <section id="artifacts"><div class="grid"><div class="card gold-minor"><h2>Artifacts</h2><div id="artifactInfo" class="list"></div><div class="action-row" style="margin-top:12px"><button id="cleanupArtifacts" class="danger">Cleanup Runtime Artifacts</button></div><p id="artifactResult" class="muted"></p></div><div class="card gold-major"><h2>What Cleanup Touches</h2><pre>Deletes runtime screenshots, browser screenshots, managed process logs, and cloudflared logs. It does not delete source files, journal, or backups.</pre></div></div></section>
    <section id="journal"><div class="grid"><div class="card gold-major"><h2>Operation Journal</h2><div id="operationList" class="list"></div><div id="operationDetail" class="drawer hidden"></div></div><div class="card gold-minor"><h2>Legacy Entries</h2><div id="legacyList" class="list"></div></div></div></section>
  </main>
  <script>
    const state = { status: null, activity: null, recovery: null, configCheck: null, smoke: null, refreshStartedAt: null, lastRefreshMs: null, failedEndpoints: [] };
    const tabs = document.querySelectorAll('#tabs button');
    tabs.forEach(btn => btn.addEventListener('click', () => {
      tabs.forEach(b => b.classList.remove('active'));
      document.querySelectorAll('section').forEach(s => s.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(btn.dataset.tab).classList.add('active');
    }));
    const text = (v) => v === undefined || v === null || v === '' ? '-' : String(v);
    const cls = (risk) => risk === 'high' ? 'bad' : risk === 'medium' ? 'warn' : 'good';
    function kv(el, data) {
      el.innerHTML = '';
      Object.entries(data).forEach(([k, v]) => {
        const a = document.createElement('div');
        const b = document.createElement('div');
        a.textContent = k;
        b.textContent = text(v);
        el.append(a, b);
      });
    }
    function eventList(el, items, emptyText) {
      el.innerHTML = '';
      if (!items || !items.length) {
        const d = document.createElement('div');
        d.className = 'muted';
        d.textContent = emptyText;
        el.append(d);
        return;
      }
      items.forEach(item => {
        const d = document.createElement('div');
        d.className = 'event ' + (item.risk || 'low');
        const title = document.createElement('div');
        title.textContent = item.human || item.message;
        const meta = document.createElement('div');
        meta.className = 'meta';
        meta.textContent = [item.timestamp, item.tool, item.phase, item.outcome].filter(Boolean).join(' | ');
        d.append(title, meta);
        el.append(d);
      });
    }
    function simpleList(el, items, emptyText, render) {
      el.innerHTML = '';
      if (!items || !items.length) {
        const d = document.createElement('div');
        d.className = 'muted';
        d.textContent = emptyText;
        el.append(d);
        return;
      }
      items.forEach(item => el.append(render(item)));
    }
    function miniCard(titleText, metaText, risk = 'low') {
      const d = document.createElement('div');
      d.className = 'event ' + risk;
      const title = document.createElement('div');
      title.textContent = titleText;
      const meta = document.createElement('div');
      meta.className = 'meta';
      meta.textContent = metaText;
      d.append(title, meta);
      return d;
    }
    function chip(label, value, risk = 'low') {
      const d = document.createElement('div');
      d.className = 'chip ' + risk;
      d.textContent = label + ': ' + value;
      return d;
    }
    function renderSafety(status) {
      const el = document.getElementById('safetyBanner');
      el.innerHTML = '';
      el.append(
        chip('Full access', status.safety.fullAccess ? 'ON' : 'OFF', status.safety.fullAccess ? 'warn' : 'good'),
        chip('Auth', status.safety.authRequired ? 'Required' : 'OFF', status.safety.authRequired ? 'good' : 'bad'),
        chip('Public endpoint', status.safety.publicReachable ? 'Reachable' : 'Check', status.safety.publicReachable ? 'good' : 'warn'),
        chip('Tunnel', status.safety.tunnelRunning ? 'Running' : 'Stopped', status.safety.tunnelRunning ? 'good' : 'warn'),
        chip('CDP profile', status.safety.cdpAttached ? 'Attached' : 'None', status.safety.cdpAttached ? 'bad' : 'good'),
        chip('Desktop tools', status.safety.desktopToolsAvailable ? 'Available' : 'Unavailable', status.safety.desktopToolsAvailable ? 'warn' : 'good'),
        chip('Risk', status.risk.current, status.risk.current === 'high' ? 'bad' : status.risk.current === 'medium' ? 'warn' : 'good'),
      );
    }
    function renderRecovery(recovery) {
      const action = recovery.actions?.[0];
      const card = document.getElementById('nextActionCard');
      const el = document.getElementById('nextAction');
      card.className = 'card next-action gold-minor ' + (action?.priority || 'low');
      el.innerHTML = '';
      if (!action) {
        el.textContent = 'No recovery action available.';
        return;
      }
      const title = document.createElement('h3');
      title.textContent = action.title;
      const detail = document.createElement('p');
      detail.className = 'muted';
      detail.textContent = action.detail;
      el.append(title, detail);
      if (action.action) {
        const row = document.createElement('div');
        row.className = 'action-row';
        const btn = document.createElement('button');
        btn.className = action.priority === 'high' ? 'danger' : 'primary';
        btn.textContent = action.label;
        btn.addEventListener('click', () => control(action.action));
        row.append(btn);
        el.append(row);
      }
    }
    function renderCheckList(el, checks, limit = 6) {
      simpleList(el, checks.slice(0, limit), 'No checks available.', check =>
        miniCard((check.ok ? 'OK: ' : 'Check: ') + check.name, check.detail, check.ok ? 'low' : check.severity === 'critical' ? 'high' : 'medium')
      );
    }
    function renderOverview(status, configCheck, smoke) {
      kv(document.getElementById('overviewKv'), {
        'Summary': status.summary,
        'MCP URL': status.now['MCP URL'],
        'Public URL': status.now['Public URL'],
        'Current risk': status.risk.current,
        'Uptime': status.now.Uptime,
        'Last refresh': new Date().toLocaleTimeString(),
      });
      renderCheckList(document.getElementById('overviewConfig'), configCheck.checks, 5);
      renderCheckList(document.getElementById('overviewSmoke'), smoke.tests, 5);
      renderDashboardHealth();
    }
    function renderDashboardHealth() {
      kv(document.getElementById('dashboardHealth'), {
        'Last refresh ms': state.lastRefreshMs ?? '-',
        'Failed endpoints': state.failedEndpoints.length ? state.failedEndpoints.join(', ') : 'none',
        'Poll interval': '5 seconds',
        'Mode': state.status ? 'connected' : 'degraded',
      });
    }
    function categoryForTool(tool) {
      if (tool === 'shell') return 'process';
      if (tool.startsWith('browser_')) return 'browser';
      if (tool.startsWith('desktop_') || tool.startsWith('screen_') || tool === 'window_list') return 'desktop';
      if (tool.startsWith('git_')) return 'git';
      if (tool.includes('process') || tool.includes('port') || tool === 'start_process' || tool === 'tail_log' || tool === 'wait_for_port') return 'process';
      return 'filesystem';
    }
    function filteredActivityEvents() {
      const risk = document.getElementById('activityRisk')?.value || 'all';
      const category = document.getElementById('activityCategory')?.value || 'all';
      return (state.activity?.events || []).filter(event => {
        if (risk === 'warnings' && !(event.risk !== 'low' || event.error)) return false;
        if (risk === 'high' && event.risk !== 'high') return false;
        if (risk === 'errors' && !event.error) return false;
        if (category !== 'all' && categoryForTool(event.tool) !== category) return false;
        return true;
      });
    }
    function renderFilteredActivity() {
      eventList(document.getElementById('activityList'), filteredActivityEvents(), 'No activity matching the current filters.');
    }
    async function getJson(url) {
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    }
    function dashboardToken() {
      return document.querySelector('meta[name="dashboard-csrf-token"]').content;
    }
    async function postJson(url, body = {}) {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Dashboard-Token': dashboardToken() },
        body: JSON.stringify(body),
      });
      const text = await res.text();
      let data;
      try { data = text ? JSON.parse(text) : {}; } catch { data = { message: text }; }
      if (!res.ok) throw new Error(data.error || data.message || text || ('HTTP ' + res.status));
      return data;
    }
    async function control(action) {
      const el = document.getElementById('controlResult');
      el.textContent = 'Running ' + action + '...';
      try {
        const result = await postJson('/dashboard/api/control/' + action, { confirm: true });
        el.textContent = result.message || 'Done.';
        setTimeout(() => refresh().catch(() => {}), 1500);
      } catch (error) {
        el.textContent = 'Failed: ' + error.message;
      }
    }
    async function closeBrowserSession(sessionId) {
      await postJson('/dashboard/api/browser-sessions/' + encodeURIComponent(sessionId) + '/close', { confirm: true });
      await refresh();
    }
    function renderAuth(auth) {
      kv(document.getElementById('authInfo'), {
        'Auth required': auth.authRequired,
        'Access token TTL': auth.accessTokenTtlSeconds + ' seconds',
        'Refresh token': 'not issued',
        'Issuer': auth.issuer,
        'Resource URI': auth.resourceUri,
        'Metadata URL': auth.protectedResourceMetadataUrl,
        'Default scopes': auth.defaultScopes.join(', '),
        'Last tool activity': auth.lastToolActivity ? auth.lastToolActivity.timestamp + ' ' + auth.lastToolActivity.tool : '-',
      });
      document.getElementById('authNote').textContent = auth.note + '\\n\\nRedirect URIs:\\n' + auth.oauthRedirectUris.join('\\n');
    }
    function renderSessions(payload) {
      simpleList(document.getElementById('sessionList'), payload.sessions, 'No active browser sessions.', session => {
        const d = miniCard(
          session.source + ' ' + session.browser + ' - ' + (session.title || '(untitled)'),
          session.url + ' | allow: ' + (session.allowedHostnames.length ? session.allowedHostnames.join(', ') : '(none)') + ' | pages: ' + session.pageCount,
          session.source === 'cdp' ? 'high' : 'medium',
        );
        const row = document.createElement('div');
        row.className = 'action-row';
        row.style.marginTop = '8px';
        const btn = document.createElement('button');
        btn.className = 'danger';
        btn.textContent = 'Close Session';
        btn.addEventListener('click', () => closeBrowserSession(session.sessionId).catch(err => alert(err.message)));
        row.append(btn);
        d.append(row);
        return d;
      });
    }
    function renderMonitor(monitor) {
      kv(document.getElementById('monitorInfo'), {
        'Process': monitor.process?.pid ? 'RUNNING pid=' + monitor.process.pid : 'not running',
        'Script': monitor.scriptPath,
        'Test root hint': monitor.testRootHint,
        'Last event': monitor.lastEvent ? monitor.lastEvent.timestamp + ' ' + monitor.lastEvent.tool + ' ' + (monitor.lastEvent.outcome || '') : '-',
        'Rules': monitor.rules ? monitor.rules.length + ' active' : '-',
      });
      const ruleItems = (monitor.rules || []).map(rule => ({ human: rule, risk: 'low', timestamp: 'rule', tool: 'monitor' }));
      eventList(document.getElementById('monitorWarnings'), [...(monitor.recentWarnings || []), ...ruleItems], 'No recent monitor-worthy warnings.');
    }
    function renderCloudflare(data) {
      kv(document.getElementById('cloudflareInfo'), {
        'Hostname': data.hostname,
        'Tunnel': data.tunnelProcess?.pid ? 'RUNNING pid=' + data.tunnelProcess.pid : 'not running',
        'Public health': data.publicHealth.ok ? 'OK' : data.publicHealth.message,
        'Config': data.configPath,
        'Exe': data.exePath,
      });
      document.getElementById('cloudflareLogs').textContent =
        'cloudflared.out.log\\n------------------\\n' + (data.logs.out.text || '') +
        '\\n\\ncloudflared.err.log\\n------------------\\n' + (data.logs.err.text || '');
    }
    function renderTools(payload) {
      simpleList(document.getElementById('toolList'), payload.tools, 'No tools registered.', tool =>
        miniCard(
          tool.index + '. ' + tool.name + ' [' + tool.category + ']',
          'scope: ' + tool.requiredScope + ' | policy: ' + tool.policyMode + ' | journal: ' + tool.journalPolicy + ' | risk: ' + tool.riskTags.join(', '),
          tool.riskTags.includes('rce') || tool.riskTags.includes('existing-profile') || tool.riskTags.includes('irreversible') ? 'high' : tool.policyMode === 'destructive' ? 'medium' : 'low',
        )
      );
    }
    function renderArtifacts(payload) {
      simpleList(document.getElementById('artifactInfo'), payload.artifacts, 'No artifact paths found.', item =>
        miniCard(item.label, item.path + ' | ' + item.files + ' files, ' + item.size + (item.cleanup ? ' | cleanup target' : ' | preserved'), item.cleanup ? 'medium' : 'low')
      );
    }
    function renderJournal(payload) {
      simpleList(document.getElementById('operationList'), payload.operations, 'No operation-oriented entries found.', op => {
        const d = miniCard(op.tool + ' - ' + op.outcome, op.timestamp + ' | ' + op.operationId + ' | phases: ' + op.phases.join(' -> ') + (op.error ? ' | ' + op.error : ''), op.risk);
        const row = document.createElement('div');
        row.className = 'action-row';
        row.style.marginTop = '8px';
        const btn = document.createElement('button');
        btn.textContent = 'Open Details';
        btn.addEventListener('click', () => {
          const detail = document.getElementById('operationDetail');
          detail.classList.remove('hidden');
          detail.innerHTML = '';
          const title = document.createElement('h3');
          title.textContent = op.tool + ' / ' + op.outcome;
          const meta = document.createElement('div');
          meta.className = 'muted';
          meta.textContent = op.timestamp + ' | ' + op.operationId + ' | phases: ' + op.phases.join(' -> ');
          const pre = document.createElement('pre');
          pre.textContent = JSON.stringify(op, null, 2);
          const copy = document.createElement('button');
          copy.textContent = 'Copy Operation JSON';
          copy.addEventListener('click', () => navigator.clipboard.writeText(pre.textContent));
          const close = document.createElement('button');
          close.textContent = 'Close';
          close.addEventListener('click', () => detail.classList.add('hidden'));
          const actions = document.createElement('div');
          actions.className = 'action-row';
          actions.style.marginTop = '10px';
          actions.append(copy, close);
          detail.append(title, meta, actions, pre);
        });
        row.append(btn);
        d.append(row);
        return d;
      });
      simpleList(document.getElementById('legacyList'), payload.legacy, 'No legacy entries in tail.', entry =>
        miniCard(entry.tool + ' - ' + (entry.outcome || 'recorded'), entry.timestamp + (entry.error ? ' | ' + entry.error : ''), entry.error ? 'medium' : 'low')
      );
    }
    async function refresh() {
      const startedAt = performance.now();
      state.failedEndpoints = [];
      async function endpoint(name, promise, fallback = null) {
        try { return await promise; }
        catch (error) {
          state.failedEndpoints.push(name);
          if (fallback !== null) return fallback;
          throw error;
        }
      }
      const [status, activity, logs, auth, sessions, monitor, cloudflare, tools, artifacts, journal, recovery, configCheck, smoke] = await Promise.all([
        endpoint('status', getJson('/dashboard/api/status')),
        endpoint('activity', getJson('/dashboard/api/activity')),
        endpoint('logs', getJson('/dashboard/api/logs?name=serverOut&lines=80'), { text: 'Log unavailable' }),
        endpoint('auth', getJson('/dashboard/api/auth')),
        endpoint('browser-sessions', getJson('/dashboard/api/browser-sessions')),
        endpoint('monitor', getJson('/dashboard/api/monitor')),
        endpoint('cloudflare', getJson('/dashboard/api/cloudflare')),
        endpoint('tools', getJson('/dashboard/api/tools')),
        endpoint('artifacts', getJson('/dashboard/api/artifacts')),
        endpoint('journal-operations', getJson('/dashboard/api/journal-operations')),
        endpoint('recovery', getJson('/dashboard/api/recovery')),
        endpoint('config-check', getJson('/dashboard/api/config-check')),
        endpoint('smoke-tests', getJson('/dashboard/api/smoke-tests')),
      ]);
      state.status = status;
      state.activity = activity;
      state.recovery = recovery;
      state.configCheck = configCheck;
      state.smoke = smoke;
      state.lastRefreshMs = Math.round(performance.now() - startedAt);
      const risk = status.risk.current;
      const overall = document.getElementById('overallStatus');
      overall.className = 'status-pill ' + cls(risk);
      overall.textContent = status.summary;
      renderSafety(status);
      renderRecovery(recovery);
      renderOverview(status, configCheck, smoke);
      document.getElementById('localMetric').textContent = status.local.ok ? 'Online' : 'Offline';
      document.getElementById('localMetric').className = 'metric ' + (status.local.ok ? 'good-text' : 'bad-text');
      document.getElementById('localDetail').textContent = status.local.message;
      document.getElementById('publicMetric').textContent = status.public.ok ? 'Reachable' : 'Check';
      document.getElementById('publicMetric').className = 'metric ' + (status.public.ok ? 'good-text' : 'warn-text');
      document.getElementById('publicDetail').textContent = status.public.message;
      document.getElementById('authMetric').textContent = status.auth.required ? 'On' : 'Off';
      document.getElementById('authMetric').className = 'metric ' + (status.auth.required ? 'good-text' : 'bad-text');
      document.getElementById('authDetail').textContent = status.auth.detail;
      document.getElementById('riskMetric').textContent = risk[0].toUpperCase() + risk.slice(1);
      document.getElementById('riskMetric').className = 'metric ' + (risk === 'high' ? 'bad-text' : risk === 'medium' ? 'warn-text' : 'good-text');
      document.getElementById('riskDetail').textContent = status.risk.detail;
      kv(document.getElementById('nowKv'), status.now);
      renderFilteredActivity();
      eventList(document.getElementById('warningList'), activity.warnings, 'No recent warnings.');
      eventList(document.getElementById('fileActivity'), activity.fileEvents, 'No recent file activity.');
      kv(document.getElementById('securityExposure'), status.security);
      kv(document.getElementById('backupInfo'), status.backups);
      kv(document.getElementById('browserInfo'), status.browser);
      kv(document.getElementById('desktopInfo'), status.desktop);
      kv(document.getElementById('processInfo'), status.process);
      kv(document.getElementById('configInfo'), status.config);
      kv(document.getElementById('maintenanceInfo'), status.maintenance);
      document.getElementById('serverLog').textContent = logs.text || 'No log.';
      document.getElementById('profiles').innerHTML = '';
      status.profiles.forEach(p => {
        const d = document.createElement('div');
        d.className = 'event low';
        d.textContent = p.label + ' - ' + p.rootPath;
        const meta = document.createElement('div');
        meta.className = 'meta';
        meta.textContent = 'Policy: ' + p.allowedPolicyModes.join(', ') + ' | Backup: ' + p.backupPolicy;
        d.append(meta);
        document.getElementById('profiles').append(d);
      });
      document.getElementById('rawDetail').textContent = JSON.stringify({ status, activity }, null, 2);
      renderAuth(auth);
      renderSessions(sessions);
      renderMonitor(monitor);
      renderCloudflare(cloudflare);
      renderTools(tools);
      renderArtifacts(artifacts);
      renderJournal(journal);
    }
    document.getElementById('refreshNow').addEventListener('click', refresh);
    document.getElementById('overviewRefresh').addEventListener('click', refresh);
    document.getElementById('runTests').addEventListener('click', async () => {
      const result = await getJson('/dashboard/api/tests');
      state.smoke = result;
      renderCheckList(document.getElementById('overviewSmoke'), result.tests, 5);
      eventList(document.getElementById('testResult'), result.tests.map(t => ({ risk: t.ok ? 'low' : t.severity === 'critical' ? 'high' : 'medium', human: (t.ok ? 'OK: ' : 'FAIL: ') + t.name + ' - ' + t.detail, timestamp: new Date().toISOString(), tool: 'dashboard' })), 'No tests run.');
    });
    document.getElementById('copyStatus').addEventListener('click', async () => {
      const brief = await getJson('/dashboard/api/agent-brief');
      await navigator.clipboard.writeText(brief.text);
    });
    document.getElementById('copyBrief').addEventListener('click', async () => {
      const brief = await getJson('/dashboard/api/agent-brief');
      await navigator.clipboard.writeText(brief.text);
    });
    document.getElementById('copyDebugBundle').addEventListener('click', async () => {
      const bundle = await getJson('/dashboard/api/debug-bundle');
      await navigator.clipboard.writeText(bundle.text);
    });
    document.getElementById('copyActivitySummary').addEventListener('click', async () => {
      const lines = filteredActivityEvents().slice(0, 30).map(event => event.timestamp + ' [' + event.risk + '] ' + event.tool + ' - ' + event.human + (event.error ? ' Error: ' + event.error : ''));
      await navigator.clipboard.writeText(lines.join('\\n'));
    });
    document.getElementById('toggleRaw').addEventListener('click', () => {
      document.getElementById('rawDetail').classList.toggle('hidden');
    });
    document.getElementById('copyMcpUrl').addEventListener('click', async () => {
      if (state.status?.now?.['MCP URL']) await navigator.clipboard.writeText(state.status.now['MCP URL']);
    });
    document.getElementById('copyOverviewMcpUrl').addEventListener('click', async () => {
      if (state.status?.now?.['MCP URL']) await navigator.clipboard.writeText(state.status.now['MCP URL']);
    });
    document.getElementById('activityRisk').addEventListener('change', renderFilteredActivity);
    document.getElementById('activityCategory').addEventListener('change', renderFilteredActivity);
    document.getElementById('startTunnel').addEventListener('click', () => control('start-tunnel'));
    document.getElementById('stopTunnel').addEventListener('click', () => control('stop-tunnel'));
    document.getElementById('restartTunnel').addEventListener('click', () => control('restart-tunnel'));
    document.getElementById('restartServer').addEventListener('click', () => control('restart-server'));
    document.getElementById('stopServer').addEventListener('click', () => control('stop-server'));
    document.getElementById('refreshSessions').addEventListener('click', refresh);
    document.getElementById('startMonitor').addEventListener('click', async () => {
      const el = document.getElementById('monitorResult');
      try { el.textContent = (await postJson('/dashboard/api/monitor/start')).message; await refresh(); }
      catch (error) { el.textContent = 'Failed: ' + error.message; }
    });
    document.getElementById('stopMonitor').addEventListener('click', async () => {
      const el = document.getElementById('monitorResult');
      try { el.textContent = (await postJson('/dashboard/api/monitor/stop', { confirm: true })).message; await refresh(); }
      catch (error) { el.textContent = 'Failed: ' + error.message; }
    });
    document.getElementById('openCloudflare').addEventListener('click', () => window.open('https://one.dash.cloudflare.com/', '_blank'));
    document.getElementById('cleanupArtifacts').addEventListener('click', async () => {
      if (!confirm('Cleanup runtime screenshots, browser artifacts, process logs, and cloudflared logs? Backups and journal are preserved.')) return;
      const el = document.getElementById('artifactResult');
      try {
        const result = await postJson('/dashboard/api/artifacts/cleanup', { confirm: true });
        el.textContent = 'Deleted: ' + result.deleted.join(', ');
        await refresh();
      } catch (error) {
        el.textContent = 'Failed: ' + error.message;
      }
    });
    refresh().catch(err => {
      document.getElementById('overallStatus').className = 'status-pill bad';
      document.getElementById('overallStatus').textContent = 'Dashboard error';
      document.getElementById('rawDetail').classList.remove('hidden');
      document.getElementById('rawDetail').textContent = err.stack || String(err);
    });
    setInterval(() => refresh().catch(() => {}), 5000);
  </script>
</body>
</html>`;
}

function hostFromHeader(req: Request): string {
  const host = req.headers.host || "";
  if (host.startsWith("[")) {
    return host.slice(0, host.indexOf("]") + 1);
  }
  return host.split(":")[0];
}

export function isLoopbackAddress(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.toLowerCase().replace(/^::ffff:/, "");
  return normalized === "::1" || normalized === "localhost" || /^127(?:\.\d{1,3}){3}$/.test(normalized);
}

function isLocalDashboardRequest(req: Request): boolean {
  return LOCAL_HOSTS.has(hostFromHeader(req).toLowerCase()) && isLoopbackAddress(req.socket.remoteAddress);
}

function requireLocalDashboard(req: Request, res: Response): boolean {
  if (isLocalDashboardRequest(req)) {
    return true;
  }
  res.status(404).json({ error: "not_found" });
  return false;
}

async function health(url: string): Promise<{ ok: boolean; statusCode?: number; message: string; url: string }> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(4000) });
    return {
      message: response.ok ? "OK" : `HTTP ${response.status}`,
      ok: response.ok,
      statusCode: response.status,
      url,
    };
  } catch (error) {
    return {
      message: error instanceof Error ? error.message : String(error),
      ok: false,
      url,
    };
  }
}

async function runCommand(
  executable: string,
  args: string[],
  timeoutMs = 10_000,
): Promise<{ code: number | null; stderr: string; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${executable} timed out`));
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stderr, stdout });
    });
  });
}

async function runPowerShell(command: string): Promise<string> {
  const result = await runCommand(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command],
  );
  if (result.code !== 0) {
    throw new Error(result.stderr || result.stdout || "PowerShell command failed");
  }
  return result.stdout.trim();
}

async function tunnelProcess(): Promise<{ commandLine?: string; pid?: number }> {
  const script = `
$process = Get-CimInstance Win32_Process -Filter "Name='cloudflared.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like '*${TUNNEL_NAME}*' } |
  Select-Object -First 1 ProcessId,CommandLine
if ($process) {
  [ordered]@{ pid = [int]$process.ProcessId; commandLine = [string]$process.CommandLine } | ConvertTo-Json -Compress
}
`;
  const stdout = await runPowerShell(script);
  if (!stdout) return {};
  return JSON.parse(stdout) as { commandLine?: string; pid?: number };
}

function cloudflaredLogPaths(): { err: string; out: string } {
  const dataDir = path.join(process.cwd(), "data");
  return {
    err: path.join(dataDir, "cloudflared.err.log"),
    out: path.join(dataDir, "cloudflared.out.log"),
  };
}

async function startTunnel(): Promise<string> {
  const existing = await tunnelProcess();
  if (existing.pid) return `Tunnel already running, pid=${existing.pid}`;
  if (!fsSync.existsSync(CLOUDFLARED_EXE)) {
    throw new Error(`cloudflared.exe not found at ${CLOUDFLARED_EXE}`);
  }
  if (!fsSync.existsSync(CLOUDFLARED_CONFIG)) {
    throw new Error(`cloudflared config not found at ${CLOUDFLARED_CONFIG}`);
  }
  const logs = cloudflaredLogPaths();
  await fs.mkdir(path.dirname(logs.out), { recursive: true });
  const out = fsSync.openSync(logs.out, "a");
  const err = fsSync.openSync(logs.err, "a");
  const child = spawn(
    CLOUDFLARED_EXE,
    ["tunnel", "--config", CLOUDFLARED_CONFIG, "run", TUNNEL_NAME],
    {
      detached: true,
      env: { ...process.env, CLOUDFLARE_TUNNEL_ENABLED: "true" },
      stdio: ["ignore", out, err],
      windowsHide: true,
    },
  );
  child.unref();
  fsSync.closeSync(out);
  fsSync.closeSync(err);
  return `Tunnel started, pid=${child.pid}`;
}

async function stopTunnel(): Promise<string> {
  const existing = await tunnelProcess();
  if (!existing.pid) return "Tunnel is not running.";
  const result = await runCommand("taskkill.exe", ["/PID", String(existing.pid), "/F"], 10_000);
  if (result.code !== 0) {
    throw new Error(result.stderr || result.stdout || `taskkill failed for pid=${existing.pid}`);
  }
  return `Tunnel stopped, pid=${existing.pid}`;
}

async function restartTunnel(): Promise<string> {
  await stopTunnel();
  await new Promise((resolve) => setTimeout(resolve, 600));
  return startTunnel();
}

async function liveMonitorProcess(): Promise<{ commandLine?: string; pid?: number }> {
  const script = `
$process = Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like '*scripts\\\\live-monitor.ps1*' -or $_.CommandLine -like '*scripts\\live-monitor.ps1*' } |
  Select-Object -First 1 ProcessId,CommandLine
if ($process) {
  [ordered]@{ pid = [int]$process.ProcessId; commandLine = [string]$process.CommandLine } | ConvertTo-Json -Compress
}
`;
  const stdout = await runPowerShell(script);
  if (!stdout) return {};
  return JSON.parse(stdout) as { commandLine?: string; pid?: number };
}

async function startLiveMonitor(): Promise<string> {
  const existing = await liveMonitorProcess();
  if (existing.pid) return `Live monitor already running, pid=${existing.pid}`;
  if (!fsSync.existsSync(LIVE_MONITOR_SCRIPT)) {
    throw new Error(`Live monitor script not found at ${LIVE_MONITOR_SCRIPT}`);
  }
  const child = spawn(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", LIVE_MONITOR_SCRIPT],
    { cwd: process.cwd(), detached: true, stdio: "ignore", windowsHide: false },
  );
  child.unref();
  return `Live monitor started, pid=${child.pid}`;
}

async function stopLiveMonitor(): Promise<string> {
  const existing = await liveMonitorProcess();
  if (!existing.pid) return "Live monitor is not running.";
  const result = await runCommand("taskkill.exe", ["/PID", String(existing.pid), "/F"], 10_000);
  if (result.code !== 0) {
    throw new Error(result.stderr || result.stdout || `taskkill failed for pid=${existing.pid}`);
  }
  return `Live monitor stopped, pid=${existing.pid}`;
}

function quotePowerShell(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function scheduleServerRestart(): void {
  const repoRoot = process.cwd();
  const serverOut = path.join(repoRoot, "server.out.log");
  const serverErr = path.join(repoRoot, "server.err.log");
  const command = [
    "Start-Sleep -Milliseconds 900",
    `Start-Process -FilePath 'node' -ArgumentList 'dist/index.js' -WorkingDirectory ${quotePowerShell(repoRoot)} -WindowStyle Hidden -RedirectStandardOutput ${quotePowerShell(serverOut)} -RedirectStandardError ${quotePowerShell(serverErr)}`,
  ].join("; ");
  const child = spawn(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command],
    { detached: true, stdio: "ignore", windowsHide: true },
  );
  child.unref();
  setTimeout(() => process.exit(0), 250);
}

async function tailLines(filePath: string, maxLines: number): Promise<string[]> {
  try {
    const content = await fs.readFile(filePath, "utf8");
    return content.split(/\r?\n/).filter(Boolean).slice(-maxLines);
  } catch {
    return [];
  }
}

async function recentJournalEntries(journalPath: string, maxLines: number): Promise<JournalEntry[]> {
  const entries: JournalEntry[] = [];
  for (const line of await tailLines(journalPath, maxLines)) {
    try {
      entries.push(JSON.parse(line) as JournalEntry);
    } catch {
      continue;
    }
  }
  return entries;
}

function riskForEntry(entry: JournalEntry): "low" | "medium" | "high" {
  const tool = entry.tool || "";
  const text = JSON.stringify(entry).toLowerCase();
  if (
    tool === "shell" ||
    tool === "delete" ||
    tool === "process_kill" ||
    tool === "browser_cdp_connect" ||
    tool.startsWith("desktop_") ||
    text.includes(".env") ||
    text.includes("secret") ||
    text.includes("token")
  ) {
    return "high";
  }
  if (
    ["write_file", "apply_patch", "move", "copy", "git_commit", "start_process", "screen_screenshot", "screen_ocr"].includes(tool) ||
    tool.startsWith("browser_")
  ) {
    return "medium";
  }
  return "low";
}

function entryTime(entry: Pick<JournalEntry, "timestamp">): number | undefined {
  const timestamp = Date.parse(entry.timestamp);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function isCurrentEntry(entry: Pick<JournalEntry, "timestamp">, now = Date.now()): boolean {
  const timestamp = entryTime(entry);
  return timestamp !== undefined && now - timestamp <= CURRENT_RISK_WINDOW_MS;
}

function isWarningEvent(event: ActivityItem): boolean {
  if (event.phase === "intent") return false;
  return event.risk !== "low" || !!event.error;
}

function humanize(entry: JournalEntry): string {
  const tool = entry.tool || "unknown";
  const phase = entry.phase ? `${entry.phase} ` : "";
  const outcome = entry.outcome ? `${entry.outcome}` : "recorded";
  if (tool === "shell") return `GPT ran a shell command (${phase}${outcome}).`;
  if (tool === "write_file") return `GPT wrote or created a file (${phase}${outcome}).`;
  if (tool === "apply_patch") return `GPT applied a targeted patch (${phase}${outcome}).`;
  if (tool === "browser_cdp_connect") return `GPT attached to an existing browser profile (${phase}${outcome}).`;
  if (tool.startsWith("browser_")) return `GPT used browser automation: ${tool} (${phase}${outcome}).`;
  if (tool.startsWith("desktop_")) return `GPT used desktop control: ${tool} (${phase}${outcome}).`;
  if (tool.startsWith("screen_") || tool === "window_list") return `GPT inspected the screen: ${tool} (${phase}${outcome}).`;
  return `GPT used ${tool} (${phase}${outcome}).`;
}

function activityFromEntries(entries: JournalEntry[]): {
  events: ActivityItem[];
  fileEvents: ActivityItem[];
  warnings: WarningItem[];
} {
  const events = entries.slice(-80).reverse().map((entry) => ({
    cwd: entry.cwd,
    durationMs: entry.durationMs,
    error: entry.error,
    human: humanize(entry),
    operationId: entry.operationId,
    outcome: entry.outcome,
    phase: entry.phase,
    risk: riskForEntry(entry),
    timestamp: entry.timestamp,
    tool: entry.tool,
  }));
  const fileEvents = events.filter((event) =>
    ["write_file", "apply_patch", "mkdir", "copy", "move", "delete", "rollback_backup", "git_commit"].includes(event.tool),
  );
  const warnings = events
    .filter(isWarningEvent)
    .map((event) => ({
      message: event.error ? `${event.human} Error: ${event.error}` : event.human,
      risk: event.risk === "low" ? "medium" : event.risk,
      timestamp: event.timestamp,
      tool: event.tool,
    }));
  return { events, fileEvents, warnings };
}

async function directoryStats(dirPath: string): Promise<{ files: number; bytes: number; exists: boolean }> {
  try {
    let files = 0;
    let bytes = 0;
    const stack = [dirPath];
    while (stack.length) {
      const current = stack.pop()!;
      const entries = await fs.readdir(current, { withFileTypes: true });
      for (const entry of entries) {
        const itemPath = path.join(current, entry.name);
        if (entry.isDirectory()) {
          stack.push(itemPath);
        } else if (entry.isFile()) {
          files += 1;
          bytes += (await fs.stat(itemPath)).size;
        }
      }
    }
    return { bytes, exists: true, files };
  } catch {
    return { bytes: 0, exists: false, files: 0 };
  }
}

function artifactTargets(config: AppConfig): Array<{ label: string; path: string; cleanup: boolean }> {
  const dataRoot = path.dirname(path.resolve(config.journalPath));
  return [
    { cleanup: false, label: "Journal", path: config.journalPath },
    { cleanup: false, label: "Backups", path: config.backupDir },
    { cleanup: true, label: "Screen screenshots", path: path.join(dataRoot, "screenshots") },
    { cleanup: true, label: "Browser artifacts", path: path.join(dataRoot, "browser") },
    { cleanup: true, label: "Managed process logs", path: path.join(dataRoot, "processes") },
    { cleanup: true, label: "Cloudflared logs", path: dataRoot },
  ];
}

async function artifactSummary(config: AppConfig) {
  const targets = [];
  for (const target of artifactTargets(config)) {
    const stats = await directoryStats(target.path);
    targets.push({
      ...target,
      bytes: stats.bytes,
      exists: stats.exists,
      files: stats.files,
      size: formatBytes(stats.bytes),
    });
  }
  return targets;
}

async function cleanupRuntimeArtifacts(config: AppConfig): Promise<{ deleted: string[] }> {
  const deleted: string[] = [];
  for (const target of artifactTargets(config).filter((item) => item.cleanup)) {
    if (!fsSync.existsSync(target.path)) continue;
    if (target.label === "Cloudflared logs") {
      for (const fileName of ["cloudflared.out.log", "cloudflared.err.log"]) {
        const filePath = path.join(target.path, fileName);
        await fs.rm(filePath, { force: true }).catch(() => undefined);
        deleted.push(filePath);
      }
      continue;
    }
    await fs.rm(target.path, { force: true, recursive: true }).catch(() => undefined);
    deleted.push(target.path);
  }
  return { deleted };
}

function groupJournalOperations(entries: JournalEntry[]) {
  const operationMap = new Map<string, JournalEntry[]>();
  const legacy: JournalEntry[] = [];
  for (const entry of entries) {
    if (entry.operationId) {
      const items = operationMap.get(entry.operationId) || [];
      items.push(entry);
      operationMap.set(entry.operationId, items);
    } else {
      legacy.push(entry);
    }
  }
  const operations = [...operationMap.entries()]
    .map(([operationId, items]) => {
      const sorted = items.sort((a, b) => (entryTime(a) || 0) - (entryTime(b) || 0));
      const last = sorted[sorted.length - 1];
      return {
        durationMs: last.durationMs,
        error: last.error,
        events: sorted,
        operationId,
        outcome: last.outcome || "unknown",
        phases: sorted.map((item) => item.phase || "event"),
        risk: sorted.reduce<"low" | "medium" | "high">((current, item) => {
          const risk = riskForEntry(item);
          if (current === "high" || risk === "high") return "high";
          if (current === "medium" || risk === "medium") return "medium";
          return "low";
        }, "low"),
        timestamp: last.timestamp,
        tool: last.tool,
      };
    })
    .sort((a, b) => (Date.parse(b.timestamp) || 0) - (Date.parse(a.timestamp) || 0));
  return { legacy: legacy.slice(-80).reverse(), operations };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function buildStatus(runtime: DashboardRuntime) {
  const { config, recoveredOperations } = runtime;
  const localUrl = `http://${config.host}:${config.port}/healthz`;
  const publicUrl = `${config.publicBaseUrl}/healthz`;
  const [local, publicHealth, entries, backupStats, screenshotStats, browserStats, tunnel, browserSessions] = await Promise.all([
    health(localUrl),
    health(publicUrl),
    recentJournalEntries(config.journalPath, 200),
    directoryStats(config.backupDir),
    directoryStats(path.join(process.cwd(), "data", "screenshots")),
    directoryStats(path.join(process.cwd(), "data", "browser")),
    tunnelProcess().catch(
      (error): { commandLine?: string; pid?: number } => ({
        commandLine: error instanceof Error ? error.message : String(error),
      }),
    ),
    browserSessionDashboardSummaries().catch(() => []),
  ]);
  const activity = activityFromEntries(entries);
  const currentWarnings = activity.warnings.filter((warning) => isCurrentEntry(warning));
  const highWarnings = currentWarnings.filter((warning) => warning.risk === "high").length;
  const currentRisk = highWarnings ? "high" : currentWarnings.length ? "medium" : "low";
  const olderWarnings = activity.warnings.length - currentWarnings.length;
  const summary = !local.ok
    ? "Local server needs attention"
    : !config.authRequired
      ? "Auth is off"
      : currentRisk === "high"
        ? "High-risk activity seen"
        : !publicHealth.ok && config.cloudflareTunnelEnabled
          ? "Public endpoint needs attention"
          : "Online";

  return {
    auth: {
      detail: config.authRequired ? "OAuth guard is active." : "Development mode. Do not expose publicly.",
      required: config.authRequired,
    },
    backups: {
      "Backup folder": config.backupDir,
      "Backup files": backupStats.exists ? backupStats.files : "not found",
      "Backup size": backupStats.exists ? formatBytes(backupStats.bytes) : "not found",
      "Max backup file": formatBytes(config.maxBackupBytes),
    },
    browser: {
      "Browser sessions max": config.maxBrowserSessions,
      "Browser artifacts": browserStats.exists ? `${browserStats.files} files, ${formatBytes(browserStats.bytes)}` : "not found",
      "Browser screenshot cap": formatBytes(config.maxBrowserScreenshotBytes),
      "CDP attach": "Available as sensitive tool",
    },
    config: {
      "Auth required": config.authRequired,
      "Cloudflare tunnel flag": config.cloudflareTunnelEnabled,
      "Default cwd": config.defaultCwd,
      "Max body": formatBytes(config.maxBodyBytes),
      "Max output": formatBytes(config.maxOutputBytes),
      "Max policy": config.maxPolicyMode,
      "Process policy": config.processPolicy,
      "Shell policy": config.shellPolicy,
      "Workspace enforcement": config.enforceWorkspaceProfiles,
    },
    desktop: {
      "Screen artifacts": screenshotStats.exists ? `${screenshotStats.files} files, ${formatBytes(screenshotStats.bytes)}` : "not found",
      "Screenshot cap": formatBytes(config.maxScreenshotBytes),
      "Screenshot dimensions": `${config.maxScreenshotDimension}px / ${config.maxScreenshotAreaPixels} pixels`,
      "OCR": "Available when local OCR dependency is installed",
    },
    local,
    maintenance: {
      "Journal": config.journalPath,
      "Process cwd": process.cwd(),
      "Recovered pending ops at boot": recoveredOperations.length,
      "Server log": path.join(process.cwd(), "server.out.log"),
      "Tools registered": TOOL_DEFINITIONS.length,
    },
    now: {
      "Local URL": `http://${config.host}:${config.port}`,
      "MCP URL": config.resourceUri,
      "PID": process.pid,
      "Public URL": config.publicBaseUrl,
      "Recent tool calls": entries.length,
      "Uptime": `${Math.round(process.uptime())}s`,
    },
    process: {
      "Command": process.argv.join(" "),
      "Node": process.version,
      "PID": process.pid,
      "Platform": `${process.platform} ${os.release()}`,
      "Tunnel command": tunnel.commandLine || "-",
      "Tunnel PID": tunnel.pid || "not running",
      "Working directory": process.cwd(),
    },
    profiles: config.workspaceProfiles,
    public: publicHealth,
    risk: {
      current: currentRisk,
      detail: currentWarnings.length
        ? `${currentWarnings.length} current warning(s) in the last 15 minutes. ${olderWarnings} older warning(s) in journal tail.`
        : olderWarnings
          ? `No current warnings. ${olderWarnings} older warning(s) remain in journal history.`
          : "No current warnings.",
    },
    security: {
      "Allowed hosts": config.allowedHosts.join(", "),
      "Auth required": config.authRequired,
      "Public health": publicHealth.ok ? "reachable" : publicHealth.message,
      "Resource URI": config.resourceUri,
      "Process policy": config.processPolicy,
      "Shell policy": config.shellPolicy,
      "Tunnel flag": config.cloudflareTunnelEnabled,
    },
    safety: {
      authRequired: config.authRequired,
      cdpAttached: browserSessions.some((session) => session.source === "cdp"),
      desktopToolsAvailable: process.platform === "win32",
      fullAccess: true,
      publicReachable: publicHealth.ok,
      tunnelRunning: !!tunnel.pid,
    },
    summary,
    tools: TOOL_DEFINITIONS.map((tool, index) => ({
      category: tool.category,
      index,
      journalPolicy: tool.journalPolicy,
      name: tool.name,
      policyMode: tool.policyMode,
      requiredScope: tool.requiredScope,
      riskTags: tool.riskTags,
    })),
  };
}

function checkSeverity(ok: boolean, critical: boolean): DashboardCheck["severity"] {
  if (ok) return "info";
  return critical ? "critical" : "warning";
}

function buildConfigChecks(status: Awaited<ReturnType<typeof buildStatus>>, config: AppConfig): { checks: DashboardCheck[]; ok: boolean; summary: string } {
  const publicUrl = new URL(config.publicBaseUrl);
  const resourceUrl = new URL(config.resourceUri);
  const checks: DashboardCheck[] = [
    {
      detail: config.authRequired ? "OAuth is required for MCP access." : "Development mode is active. Do not expose a tunnel.",
      name: "Auth guard",
      ok: config.authRequired,
      severity: checkSeverity(config.authRequired, true),
    },
    {
      detail: config.cloudflareTunnelEnabled
        ? "Tunnel mode is enabled in runtime config."
        : "Tunnel flag is off; public connector use should keep this enabled.",
      name: "Cloudflare tunnel flag",
      ok: config.cloudflareTunnelEnabled,
      severity: checkSeverity(config.cloudflareTunnelEnabled, false),
    },
    {
      detail: config.publicBaseUrl,
      name: "Public base URL uses HTTPS",
      ok: publicUrl.protocol === "https:" || LOCAL_HOSTS.has(publicUrl.hostname),
      severity: checkSeverity(publicUrl.protocol === "https:" || LOCAL_HOSTS.has(publicUrl.hostname), true),
    },
    {
      detail: config.resourceUri,
      name: "MCP resource URI matches public URL",
      ok: resourceUrl.href === new URL("/mcp", config.publicBaseUrl).href,
      severity: checkSeverity(resourceUrl.href === new URL("/mcp", config.publicBaseUrl).href, true),
    },
    {
      detail: config.oauthRedirectUris.length ? `${config.oauthRedirectUris.length} redirect URI(s) configured.` : "No redirect URI configured.",
      name: "OAuth redirect URIs",
      ok: config.oauthRedirectUris.length > 0,
      severity: checkSeverity(config.oauthRedirectUris.length > 0, true),
    },
    {
      detail: config.allowedGithubLogins.length ? `${config.allowedGithubLogins.length} GitHub login(s) allowed.` : "No GitHub login allowlist.",
      name: "GitHub login allowlist",
      ok: config.allowedGithubLogins.length > 0,
      severity: checkSeverity(config.allowedGithubLogins.length > 0, true),
    },
    {
      detail: `${formatBytes(config.maxBodyBytes)} body / ${formatBytes(config.maxOutputBytes)} output.`,
      name: "Body limit can carry tool payloads",
      ok: config.maxBodyBytes >= Math.ceil(config.maxOutputBytes * 1.1),
      severity: checkSeverity(config.maxBodyBytes >= Math.ceil(config.maxOutputBytes * 1.1), false),
    },
    {
      detail: config.enforceWorkspaceProfiles ? `${config.workspaceProfiles.length} profile(s) configured.` : "Workspace profile enforcement is disabled.",
      name: "Workspace profiles",
      ok: config.enforceWorkspaceProfiles && config.workspaceProfiles.length > 0,
      severity: checkSeverity(config.enforceWorkspaceProfiles && config.workspaceProfiles.length > 0, false),
    },
    {
      detail: status.local.message,
      name: "Local health",
      ok: status.local.ok,
      severity: checkSeverity(status.local.ok, true),
    },
    {
      detail: status.public.message,
      name: "Public health",
      ok: !config.cloudflareTunnelEnabled || status.public.ok,
      severity: checkSeverity(!config.cloudflareTunnelEnabled || status.public.ok, false),
    },
  ];
  const failures = checks.filter((check) => !check.ok);
  return {
    checks,
    ok: failures.length === 0,
    summary: failures.length ? `${failures.length} item(s) need attention.` : "Configuration looks coherent.",
  };
}

function buildRecoveryPlan(status: Awaited<ReturnType<typeof buildStatus>>): { actions: RecoveryAction[]; summary: string } {
  const actions: RecoveryAction[] = [];
  if (!status.local.ok) {
    actions.push({
      detail: "The local server is not answering health checks. Use the fallback app if this web dashboard is unavailable.",
      label: "Start server",
      priority: "high",
      title: "Start the local MCP server",
    });
  }
  if (status.auth.required === false) {
    actions.push({
      detail: "Auth is disabled. Do not expose a public tunnel in this state.",
      label: "Check auth env",
      priority: "high",
      title: "Enable OAuth before public use",
    });
  }
  if (status.safety.tunnelRunning === false && status.security["Tunnel flag"] === true) {
    actions.push({
      action: "start-tunnel",
      detail: "The runtime expects Cloudflare Tunnel, but no tunnel process is running.",
      label: "Start tunnel",
      priority: "high",
      title: "Start Cloudflare Tunnel",
    });
  }
  if (!status.public.ok && status.security["Tunnel flag"] === true) {
    actions.push({
      action: "restart-tunnel",
      detail: `Public health is failing: ${status.public.message}`,
      label: "Restart tunnel",
      priority: "medium",
      title: "Repair the public endpoint",
    });
  }
  if (status.risk.current === "high") {
    actions.push({
      detail: status.risk.detail,
      label: "Review activity",
      priority: "high",
      title: "Review high-risk activity",
    });
  }
  if (!actions.length) {
    actions.push({
      detail: "No immediate recovery action is needed.",
      label: "Keep monitoring",
      priority: "low",
      title: "System looks stable",
    });
  }
  return { actions, summary: actions[0].title };
}

async function buildSmokeTests(runtime: DashboardRuntime) {
  const status = await buildStatus(runtime);
  const metadata = await health(`${runtime.config.publicBaseUrl}/.well-known/oauth-protected-resource`);
  const authServer = await health(`${runtime.config.publicBaseUrl}/.well-known/oauth-authorization-server`);
  const journalAccessible = (await tailLines(runtime.config.journalPath, 1)).length >= 0;
  const configChecks = buildConfigChecks(status, runtime.config);
  const tests: DashboardCheck[] = [
    { detail: status.local.message, name: "Local health", ok: status.local.ok, severity: checkSeverity(status.local.ok, true) },
    { detail: status.public.message, name: "Public health", ok: status.public.ok, severity: checkSeverity(status.public.ok, false) },
    { detail: metadata.message, name: "Protected resource metadata", ok: metadata.ok, severity: checkSeverity(metadata.ok, true) },
    { detail: authServer.message, name: "Authorization server metadata", ok: authServer.ok, severity: checkSeverity(authServer.ok, true) },
    { detail: runtime.config.authRequired ? "OAuth required" : "Development mode", name: "Auth guard", ok: runtime.config.authRequired, severity: checkSeverity(runtime.config.authRequired, true) },
    { detail: runtime.config.journalPath, name: "Journal readable", ok: journalAccessible, severity: checkSeverity(journalAccessible, false) },
    ...configChecks.checks.map((check) => ({ ...check, name: `Config: ${check.name}` })),
  ];
  return {
    failed: tests.filter((test) => !test.ok).length,
    generatedAt: new Date().toISOString(),
    passed: tests.filter((test) => test.ok).length,
    tests,
  };
}

async function buildDebugBundle(runtime: DashboardRuntime): Promise<string> {
  const status = await buildStatus(runtime);
  const recovery = buildRecoveryPlan(status);
  const configChecks = buildConfigChecks(status, runtime.config);
  const activity = activityFromEntries(await recentJournalEntries(runtime.config.journalPath, 250));
  return [
    "chatgpt-local-agent-mcp-debug-bundle",
    `Generated: ${new Date().toISOString()}`,
    "",
    `Summary: ${status.summary}`,
    `Next action: ${recovery.summary}`,
    `Risk: ${status.risk.current} - ${status.risk.detail}`,
    "",
    "Connectivity",
    `- Local: ${status.local.ok ? "OK" : "FAIL"} ${status.local.message}`,
    `- Public: ${status.public.ok ? "OK" : "FAIL"} ${status.public.message}`,
    `- MCP URL: ${status.now["MCP URL"]}`,
    `- Public URL: ${status.now["Public URL"]}`,
    "",
    "Safety",
    `- Full access: ${status.safety.fullAccess}`,
    `- Auth required: ${status.safety.authRequired}`,
    `- Public reachable: ${status.safety.publicReachable}`,
    `- Tunnel running: ${status.safety.tunnelRunning}`,
    `- CDP attached: ${status.safety.cdpAttached}`,
    `- Desktop tools available: ${status.safety.desktopToolsAvailable}`,
    "",
    "Config checks",
    ...configChecks.checks.map((check) => `- ${check.ok ? "OK" : "FAIL"} ${check.name}: ${check.detail}`),
    "",
    "Recent warnings",
    ...(activity.warnings.length
      ? activity.warnings.slice(0, 12).map((warning) => `- ${warning.timestamp} [${warning.risk}] ${warning.tool}: ${warning.message}`)
      : ["- none"]),
    "",
    "Runtime",
    `- PID: ${status.now.PID}`,
    `- CWD: ${status.process["Working directory"]}`,
    `- Journal: ${status.maintenance.Journal}`,
    `- Node: ${status.process.Node}`,
    `- Tools registered: ${status.maintenance["Tools registered"]}`,
  ].join("\n");
}

function briefFromStatus(status: Awaited<ReturnType<typeof buildStatus>>): string {
  return [
    "chatgpt-local-agent-mcp-diagnostic-brief",
    "",
    `Summary: ${status.summary}`,
    `Local: ${status.local.ok ? "OK" : "FAIL"} ${status.local.message}`,
    `Public: ${status.public.ok ? "OK" : "FAIL"} ${status.public.message}`,
    `MCP URL: ${status.now["MCP URL"]}`,
    `Public URL: ${status.now["Public URL"]}`,
    `PID: ${status.now.PID}`,
    `CWD: ${status.process["Working directory"]}`,
    `Journal: ${status.maintenance.Journal}`,
    `Risk: ${status.risk.current} - ${status.risk.detail}`,
    `Auth required: ${status.auth.required}`,
    `Workspace enforcement: ${status.config["Workspace enforcement"]}`,
    `Max policy: ${status.config["Max policy"]}`,
    "",
    "Workspace profiles:",
    ...status.profiles.map((profile) => `- ${profile.label}: ${profile.rootPath}`),
    "",
    "Use this brief to orient maintenance/debugging. Dashboard is local-only.",
  ].join("\n");
}

export function registerDashboardRoutes(app: { use: (path: string, router: Router) => void }, runtime: DashboardRuntime): void {
  const router = Router();
  router.use((req, res, next) => {
    if (!requireLocalDashboard(req, res)) return;
    next();
  });
  router.use((req, res, next) => {
    if (!["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) {
      next();
      return;
    }
    if (req.get("x-dashboard-token") !== DASHBOARD_CSRF_TOKEN) {
      res.status(403).json({ error: "csrf_denied" });
      return;
    }
    next();
  });

  router.get("/", (_req: Request, res: Response) => {
    res.type("html").send(dashboardHtml(DASHBOARD_CSRF_TOKEN));
  });

  router.get("/api/status", async (_req: Request, res: Response) => {
    res.json(await buildStatus(runtime));
  });

  router.get("/api/activity", async (_req: Request, res: Response) => {
    const entries = await recentJournalEntries(runtime.config.journalPath, 250);
    res.json(activityFromEntries(entries));
  });

  router.get("/api/recovery", async (_req: Request, res: Response) => {
    res.json(buildRecoveryPlan(await buildStatus(runtime)));
  });

  router.get("/api/config-check", async (_req: Request, res: Response) => {
    res.json(buildConfigChecks(await buildStatus(runtime), runtime.config));
  });

  router.get("/api/logs", async (req: Request, res: Response) => {
    const name = typeof req.query.name === "string" ? req.query.name : "serverOut";
    const lines = typeof req.query.lines === "string" ? Number.parseInt(req.query.lines, 10) : 120;
    const allowed: Record<string, string> = {
      journal: runtime.config.journalPath,
      serverErr: path.join(process.cwd(), "server.err.log"),
      serverOut: path.join(process.cwd(), "server.out.log"),
    };
    const target = allowed[name] || allowed.serverOut;
    res.json({
      name,
      path: target,
      text: (await tailLines(target, Number.isFinite(lines) ? lines : 120)).join("\n"),
    });
  });

  router.get("/api/tests", async (_req: Request, res: Response) => {
    res.json(await buildSmokeTests(runtime));
  });

  router.get("/api/smoke-tests", async (_req: Request, res: Response) => {
    res.json(await buildSmokeTests(runtime));
  });

  router.get("/api/agent-brief", async (_req: Request, res: Response) => {
    res.json({ text: briefFromStatus(await buildStatus(runtime)) });
  });

  router.get("/api/debug-bundle", async (_req: Request, res: Response) => {
    res.json({ text: await buildDebugBundle(runtime) });
  });

  router.get("/api/auth", async (_req: Request, res: Response) => {
    const entries = await recentJournalEntries(runtime.config.journalPath, 250);
    const latest = entries[entries.length - 1];
    res.json({
      accessTokenTtlSeconds: ACCESS_TOKEN_TTL_SECONDS,
      authRequired: runtime.config.authRequired,
      defaultScopes: runtime.config.defaultOauthScopes,
      issuer: runtime.config.publicBaseUrl,
      lastToolActivity: latest
        ? {
            timestamp: latest.timestamp,
            tool: latest.tool,
            outcome: latest.outcome,
          }
        : undefined,
      note: "No refresh token is intentionally issued; reconnect after token expiry is a full-access guardrail.",
      oauthRedirectUris: runtime.config.oauthRedirectUris,
      protectedResourceMetadataUrl: runtime.config.protectedResourceMetadataUrl,
      resourceUri: runtime.config.resourceUri,
    });
  });

  router.get("/api/browser-sessions", async (_req: Request, res: Response) => {
    res.json({ sessions: await browserSessionDashboardSummaries() });
  });

  router.post("/api/browser-sessions/:sessionId/close", async (req: Request, res: Response) => {
    if (!req.body?.confirm) {
      res.status(400).json({ error: "confirm=true is required" });
      return;
    }
    const sessionId = Array.isArray(req.params.sessionId) ? req.params.sessionId[0] : req.params.sessionId;
    const closed = await closeBrowserSessionForDashboard(sessionId);
    res.json({ closed, sessionId });
  });

  router.get("/api/cloudflare", async (_req: Request, res: Response) => {
    const logs = cloudflaredLogPaths();
    const [tunnel, publicHealth, outTail, errTail] = await Promise.all([
      tunnelProcess().catch((error) => ({ commandLine: error instanceof Error ? error.message : String(error) })),
      health(`${runtime.config.publicBaseUrl}/healthz`),
      tailLines(logs.out, 80),
      tailLines(logs.err, 80),
    ]);
    res.json({
      configPath: CLOUDFLARED_CONFIG,
      dashboardUrl: "https://one.dash.cloudflare.com/",
      exePath: CLOUDFLARED_EXE,
      hostname: new URL(runtime.config.publicBaseUrl).hostname,
      logs: {
        err: { path: logs.err, text: errTail.join("\n") },
        out: { path: logs.out, text: outTail.join("\n") },
      },
      publicHealth,
      tunnelName: TUNNEL_NAME,
      tunnelProcess: tunnel,
    });
  });

  router.get("/api/monitor", async (_req: Request, res: Response) => {
    const monitorProcess = await liveMonitorProcess().catch((error) => ({
      commandLine: error instanceof Error ? error.message : String(error),
    }));
    const entries = await recentJournalEntries(runtime.config.journalPath, 200);
    const lastEvent = entries[entries.length - 1];
    res.json({
      lastEvent: lastEvent
        ? {
            outcome: lastEvent.outcome,
            phase: lastEvent.phase,
            timestamp: lastEvent.timestamp,
            tool: lastEvent.tool,
          }
        : undefined,
      process: monitorProcess,
      recentWarnings: activityFromEntries(entries).warnings.slice(0, 40),
      rules: [
        "High-risk shell, browser CDP, desktop, secret-path, and destructive activity warnings",
        "STOP-style warnings for activity outside expected test roots when live-test monitoring is used",
        "Alert-only by default; no automatic process kill",
      ],
      scriptPath: LIVE_MONITOR_SCRIPT,
      testRootHint: path.join(path.dirname(globalThis.process.cwd()), "chatgpt-local-agent-mcp-live-test"),
    });
  });

  router.post("/api/monitor/start", async (_req: Request, res: Response) => {
    res.json({ message: await startLiveMonitor() });
  });

  router.post("/api/monitor/stop", async (req: Request, res: Response) => {
    if (!req.body?.confirm) {
      res.status(400).json({ error: "confirm=true is required" });
      return;
    }
    res.json({ message: await stopLiveMonitor() });
  });

  router.get("/api/tools", (_req: Request, res: Response) => {
    res.json({
      count: TOOL_DEFINITIONS.length,
      tools: TOOL_DEFINITIONS.map((tool, index) => ({
        category: tool.category,
        index,
        journalPolicy: tool.journalPolicy,
        name: tool.name,
        policyMode: tool.policyMode,
        requiredScope: tool.requiredScope,
        riskTags: tool.riskTags,
      })),
    });
  });

  router.get("/api/artifacts", async (_req: Request, res: Response) => {
    res.json({ artifacts: await artifactSummary(runtime.config) });
  });

  router.post("/api/artifacts/cleanup", async (req: Request, res: Response) => {
    if (!req.body?.confirm) {
      res.status(400).json({ error: "confirm=true is required" });
      return;
    }
    res.json(await cleanupRuntimeArtifacts(runtime.config));
  });

  router.get("/api/journal-operations", async (_req: Request, res: Response) => {
    res.json(groupJournalOperations(await recentJournalEntries(runtime.config.journalPath, 500)));
  });

  router.post("/api/control/start-tunnel", async (req: Request, res: Response) => {
    if (!req.body?.confirm) {
      res.status(400).json({ error: "confirm=true is required" });
      return;
    }
    res.json({ message: await startTunnel() });
  });

  router.post("/api/control/stop-tunnel", async (req: Request, res: Response) => {
    if (!req.body?.confirm) {
      res.status(400).json({ error: "confirm=true is required" });
      return;
    }
    res.json({ message: await stopTunnel() });
  });

  router.post("/api/control/restart-tunnel", async (req: Request, res: Response) => {
    if (!req.body?.confirm) {
      res.status(400).json({ error: "confirm=true is required" });
      return;
    }
    res.json({ message: await restartTunnel() });
  });

  router.post("/api/control/stop-server", (req: Request, res: Response) => {
    if (!req.body?.confirm) {
      res.status(400).json({ error: "confirm=true is required" });
      return;
    }
    res.json({ message: "Local MCP server stopping. Use the fallback app to start it again." });
    setTimeout(() => process.exit(0), 250);
  });

  router.post("/api/control/restart-server", (req: Request, res: Response) => {
    if (!req.body?.confirm) {
      res.status(400).json({ error: "confirm=true is required" });
      return;
    }
    res.json({ message: "Local MCP server restarting. Refresh in a few seconds." });
    scheduleServerRestart();
  });

  app.use("/dashboard", router);
}
