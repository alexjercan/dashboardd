export function mount(container, context) {
  const input = document.createElement("p");
  input.className = "fixture-input";
  const output = document.createElement("output");
  output.textContent = `Waiting for ${context.widgetId}`;
  const renderInput = (value) => {
    input.textContent =
      value === undefined ? "Input is unbound" : JSON.stringify(value);
  };
  renderInput(context.inputs.get("message"));
  const unsubscribe = context.inputs.subscribe("message", renderInput);
  container.replaceChildren(input, output);
  return {
    update(payload) {
      output.textContent = JSON.stringify(payload);
    },
    destroy() {
      unsubscribe();
      container.replaceChildren();
    },
  };
}
