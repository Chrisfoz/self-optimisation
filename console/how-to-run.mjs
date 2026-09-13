// Copy buttons for the How to run page's command boxes. A file rather than an
// inline script because the server's content security policy allows scripts
// from this origin only. The command text stays selectable without it.
for (const box of document.querySelectorAll(".cmd")) {
  const pre = box.querySelector("pre");
  if (!pre) continue;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "copy";
  button.textContent = "Copy";
  button.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(pre.textContent);
      button.textContent = "Copied";
    } catch {
      button.textContent = "Select and copy";
    }
    setTimeout(() => {
      button.textContent = "Copy";
    }, 1600);
  });
  box.appendChild(button);
}
