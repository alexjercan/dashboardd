export class CommandPalette {
  readonly dialog: HTMLDialogElement;
  private readonly form: HTMLFormElement;
  private readonly input: HTMLInputElement;
  private readonly error: HTMLElement;
  private readonly list: HTMLElement;
  private candidates: string[] = [];
  private filtered: string[] = [];
  private highlighted = 0;
  private history: string[] = [];
  private historyIndex = 0;

  constructor(
    private readonly available: () => string[],
    private readonly execute: (command: string) => string | null,
  ) {
    this.dialog = document.createElement("dialog");
    this.dialog.className = "modal command-palette-modal";
    this.dialog.innerHTML = `
      <form class="command-form">
        <header><h2>Command</h2><button class="icon-button" value="cancel" formmethod="dialog" aria-label="Close">x</button></header>
        <label class="command-line"><span aria-hidden="true">:</span><span class="sr-only">Dashboard command</span><input class="command-input" autocomplete="off" spellcheck="false" placeholder="Type a command"></label>
        <ul class="command-completions" role="listbox" hidden></ul>
        <p class="command-error" role="alert" hidden></p>
      </form>`;
    document.body.append(this.dialog);
    this.form = required(this.dialog, ".command-form");
    this.input = required(this.dialog, ".command-input");
    this.error = required(this.dialog, ".command-error");
    this.list = required(this.dialog, ".command-completions");
    this.form.addEventListener("submit", (event) => this.submit(event));
    this.input.addEventListener("input", () => this.renderCompletions());
    this.input.addEventListener("keydown", (event) =>
      this.handleKeydown(event),
    );
    this.list.addEventListener("pointerdown", (event) => {
      const item = (event.target as Element).closest<HTMLElement>(
        "[data-command]",
      );
      if (!item?.dataset.command) return;
      event.preventDefault();
      this.input.value = item.dataset.command;
      this.renderCompletions();
      this.input.focus();
    });
    this.dialog.addEventListener("close", () => this.reset());
  }

  open(prefill = ""): void {
    this.candidates = [...new Set(this.available())].sort((left, right) =>
      left.localeCompare(right),
    );
    this.input.value = prefill;
    this.error.hidden = true;
    this.historyIndex = this.history.length;
    this.dialog.showModal();
    this.renderCompletions();
    this.input.focus();
    this.input.setSelectionRange(prefill.length, prefill.length);
  }

  close(): void {
    this.dialog.close();
  }

  private submit(event: SubmitEvent): void {
    event.preventDefault();
    const value = this.input.value.trim();
    if (!value) return;
    const error = this.execute(value);
    if (error) {
      this.error.textContent = error;
      this.error.hidden = false;
      return;
    }
    if (this.history[this.history.length - 1] !== value) {
      this.history.push(value);
      if (this.history.length > 20) this.history.shift();
    }
    this.close();
  }

  private handleKeydown(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      event.preventDefault();
      this.close();
      return;
    }
    if (event.key === "Tab") {
      if (!this.filtered.length) return;
      event.preventDefault();
      this.input.value = this.filtered[this.highlighted];
      this.renderCompletions();
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const offset = event.key === "ArrowDown" ? 1 : -1;
      if (!this.input.value && this.history.length) this.recallHistory(offset);
      else if (this.filtered.length) {
        this.highlighted =
          (this.highlighted + offset + this.filtered.length) %
          this.filtered.length;
        this.renderList();
      }
    }
  }

  private recallHistory(offset: number): void {
    if (!this.history.length) return;
    this.historyIndex = Math.max(
      0,
      Math.min(this.history.length, this.historyIndex + offset),
    );
    this.input.value = this.history[this.historyIndex] ?? "";
    this.renderCompletions();
  }

  private renderCompletions(): void {
    const query = this.input.value
      .trim()
      .toLocaleLowerCase()
      .split(/\s+/)
      .filter(Boolean);
    this.filtered = this.candidates
      .filter((candidate) => {
        const words = candidate.toLocaleLowerCase().split(/\s+/);
        return query.every((part) =>
          words.some((word) => word.startsWith(part)),
        );
      })
      .slice(0, 8);
    this.highlighted = Math.min(this.highlighted, this.filtered.length - 1);
    if (this.highlighted < 0) this.highlighted = 0;
    this.renderList();
  }

  private renderList(): void {
    this.list.replaceChildren();
    this.filtered.forEach((candidate, index) => {
      const item = document.createElement("li");
      item.id = `command-completion-${index}`;
      item.dataset.command = candidate;
      item.setAttribute("role", "option");
      item.setAttribute("aria-selected", String(index === this.highlighted));
      item.textContent = candidate;
      this.list.append(item);
    });
    this.list.hidden = this.filtered.length === 0;
    const active = this.filtered.length
      ? `command-completion-${this.highlighted}`
      : null;
    if (active) this.input.setAttribute("aria-activedescendant", active);
    else this.input.removeAttribute("aria-activedescendant");
  }

  private reset(): void {
    this.input.blur();
    window.setTimeout(() => {
      if (!this.dialog.open && this.dialog.contains(document.activeElement))
        (document.activeElement as HTMLElement).blur();
    });
    this.input.value = "";
    this.filtered = [];
    this.list.replaceChildren();
    this.list.hidden = true;
    this.error.hidden = true;
  }
}

function required<T extends Element>(root: ParentNode, selector: string): T {
  const element = root.querySelector<T>(selector);
  if (!element) throw new Error(`missing command palette element: ${selector}`);
  return element;
}
