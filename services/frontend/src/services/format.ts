// Small wording helpers for counts shown to the user.

/** `1 device`, `3 devices`, `0 devices`: the count with the right form of the noun. The plural
 *  defaults to the singular plus `s`; pass it for an irregular one. */
export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}
