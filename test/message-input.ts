import { expect, type Locator } from '@playwright/test';

export const inputText = (input: Locator) =>
    input.evaluate((node) =>
        [...node.querySelectorAll('.cm-line')]
            .map((line) => {
                const copy = line.cloneNode(true) as HTMLElement;
                copy.querySelectorAll('.cm-placeholder').forEach(
                    (placeholder) => placeholder.remove()
                );
                return copy.textContent || '';
            })
            .join('\n')
    );

export async function expectInput(input: Locator, text: string) {
    await expect.poll(() => inputText(input)).toBe(text);
}
