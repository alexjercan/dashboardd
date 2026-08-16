export function mount(container, context) {
  const output = document.createElement("output");
  output.textContent = `Waiting for ${context.widgetId}`;
  container.replaceChildren(output);
  return {
    update(payload) {
      output.textContent = JSON.stringify(payload);
    },
    destroy() {
      container.replaceChildren();
    },
  };
}
