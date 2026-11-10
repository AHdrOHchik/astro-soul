/** Focuses the first unfinished text field inside `container`, or simply the first one. */
export function focusFirstOpenInput(container: HTMLElement | null): void {
  if (!container) return;
  const inputs = Array.from(container.querySelectorAll('input'));
  const target = inputs.find((input) => input.maxLength > 0 && input.value.length < input.maxLength) ?? inputs[0];
  target?.focus();
}

/** Focuses the chosen option of the group inside `container`, or the first one while nothing is chosen. */
export function focusChosenOption(container: HTMLElement | null): void {
  if (!container) return;
  const target = container.querySelector<HTMLInputElement>('input:checked') ?? container.querySelector('input');
  target?.focus();
}
