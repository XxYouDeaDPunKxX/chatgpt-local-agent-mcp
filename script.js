const revealElements = document.querySelectorAll(".reveal");

const observer = new IntersectionObserver(
  entries => {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        entry.target.classList.add("in-view");
        observer.unobserve(entry.target);
      }
    }
  },
  { threshold: 0.15 }
);

revealElements.forEach(element => observer.observe(element));

const prompts = [
  "Clean this project folder, but do not lose anything.",
  "Open the browser and check what broke on this page.",
  "Read the repo, run the check, and bring back the failure.",
  "Prepare a safe edit, backup first, then wait for approval."
];

const cards = Array.from(document.querySelectorAll(".map-card"));
const promptText = document.querySelector("#promptText");
let activeIndex = 0;

function rotateFlow() {
  cards.forEach(card => card.classList.remove("active"));
  cards[activeIndex % cards.length]?.classList.add("active");

  if (promptText && activeIndex % cards.length === 0) {
    const promptIndex = Math.floor(activeIndex / cards.length) % prompts.length;
    promptText.textContent = prompts[promptIndex];
  }

  activeIndex += 1;
}

window.setInterval(rotateFlow, 1600);

const copyButton = document.querySelector(".copy-link");

copyButton?.addEventListener("click", async () => {
  const value = copyButton.dataset.copy || "";

  try {
    await navigator.clipboard.writeText(value);
    copyButton.textContent = "Copied";
    window.setTimeout(() => {
      copyButton.textContent = "Copy link";
    }, 1500);
  } catch {
    copyButton.textContent = value;
  }
});
