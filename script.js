const revealEls = document.querySelectorAll('.reveal');

const revealObserver = new IntersectionObserver(
  entries => {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        entry.target.classList.add('in-view');
        revealObserver.unobserve(entry.target);
      }
    }
  },
  { threshold: 0.16 }
);

revealEls.forEach(el => revealObserver.observe(el));

const requests = [
  'Clean this messy project folder without losing anything.',
  'Open the browser, inspect the page and tell me what broke.',
  'Read these files, make a backup, then prepare the safe edit.',
  'Run the check, capture the output and explain the failure.'
];

const nodes = Array.from(document.querySelectorAll('.node'));
const requestEl = document.querySelector('#demo-request');
let step = 0;

function rotateDemo() {
  nodes.forEach(node => node.classList.remove('active'));
  nodes[step % nodes.length]?.classList.add('active');
  if (requestEl && step % nodes.length === 0) {
    requestEl.textContent = requests[(step / nodes.length) % requests.length];
  }
  step += 1;
}

setInterval(rotateDemo, 1700);

const copyButton = document.querySelector('.copy-button');
copyButton?.addEventListener('click', async () => {
  const value = copyButton.getAttribute('data-copy') || '';
  try {
    await navigator.clipboard.writeText(value);
    copyButton.textContent = 'Copied';
    setTimeout(() => { copyButton.textContent = 'Copy GitHub link'; }, 1600);
  } catch {
    copyButton.textContent = value;
  }
});
