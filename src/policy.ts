export const POLICY_MODES = ["observe", "diagnose", "edit", "operate", "destructive"] as const;

export type PolicyMode = (typeof POLICY_MODES)[number];

const POLICY_MODE_RANK: Record<PolicyMode, number> = {
  observe: 0,
  diagnose: 1,
  edit: 2,
  operate: 3,
  destructive: 4,
};

export function isPolicyMode(value: string): value is PolicyMode {
  return (POLICY_MODES as readonly string[]).includes(value);
}

export function parsePolicyMode(value: string, name: string): PolicyMode {
  if (!isPolicyMode(value)) {
    throw new Error(`${name} must be one of: ${POLICY_MODES.join(", ")}`);
  }
  return value;
}

export function isPolicyModeAllowed(policyMode: PolicyMode, maxPolicyMode: PolicyMode): boolean {
  return POLICY_MODE_RANK[policyMode] <= POLICY_MODE_RANK[maxPolicyMode];
}

export function policyModesUpTo(maxPolicyMode: PolicyMode): PolicyMode[] {
  return POLICY_MODES.filter((policyMode) => isPolicyModeAllowed(policyMode, maxPolicyMode));
}
