export type PreferenceLanguage = "en" | "zh";

export type PreferenceOptionPresentation = {
  id: string;
  text: string;
};

export type ProbePresentation = {
  recap: string;
  question: string;
  options: PreferenceOptionPresentation[];
};

export type BulkPreferencePresentation = {
  question: string;
};

export type ProbePresentations = Partial<Record<PreferenceLanguage, ProbePresentation>>;
export type BulkPreferencePresentations = Partial<Record<PreferenceLanguage, BulkPreferencePresentation>>;

const LANGUAGES: PreferenceLanguage[] = ["en", "zh"];
const nonEmptyString = (value: unknown, maximum = 20_000): value is string => (
  typeof value === "string" && value.trim().length > 0 && value.length <= maximum
);

const exactOptionIds = (
  options: PreferenceOptionPresentation[],
  canonicalOptions: PreferenceOptionPresentation[],
) => options.length === canonicalOptions.length
  && options.every((option, index) => option.id === canonicalOptions[index]?.id)
  && new Set(options.map((option) => option.id)).size === options.length;

/** Validate localized display copy without changing the stable probe/answer identity. */
export function normalizeProbePresentations(
  value: unknown,
  canonicalOptions: PreferenceOptionPresentation[],
): ProbePresentations | null {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => !LANGUAGES.includes(key as PreferenceLanguage))) return null;
  const normalized: ProbePresentations = {};
  for (const language of LANGUAGES) {
    const candidate = input[language];
    if (candidate === undefined) continue;
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
    const presentation = candidate as Partial<ProbePresentation>;
    if (!nonEmptyString(presentation.recap) || !nonEmptyString(presentation.question)
      || !Array.isArray(presentation.options)
      || !presentation.options.every((option) => nonEmptyString(option?.id, 200)
        && nonEmptyString(option?.text))
      || !exactOptionIds(presentation.options, canonicalOptions)) return null;
    normalized[language] = {
      recap: presentation.recap,
      question: presentation.question,
      options: presentation.options.map((option) => ({ id: option.id, text: option.text })),
    };
  }
  return normalized;
}

export function normalizeBulkPreferencePresentations(value: unknown): BulkPreferencePresentations | null {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => !LANGUAGES.includes(key as PreferenceLanguage))) return null;
  const normalized: BulkPreferencePresentations = {};
  for (const language of LANGUAGES) {
    const candidate = input[language];
    if (candidate === undefined) continue;
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)
      || !nonEmptyString((candidate as Partial<BulkPreferencePresentation>).question)) return null;
    normalized[language] = { question: (candidate as BulkPreferencePresentation).question };
  }
  return normalized;
}

export function resolveProbePresentation<T extends { presentations?: ProbePresentations }>(
  probe: T,
  language: PreferenceLanguage,
): (T & ProbePresentation) | null {
  const presentation = probe.presentations?.[language];
  return presentation ? { ...probe, ...presentation } : null;
}

/** Require the linked Story language without falling back. Additional reviewed
 * presentation copy may coexist under the same Preference identity. */
export function hasRequiredProbePresentation(
  presentations: unknown,
  language: PreferenceLanguage,
) {
  return Boolean(presentations && typeof presentations === "object" && !Array.isArray(presentations)
    && (presentations as ProbePresentations)[language]);
}

export function resolveBulkPreferencePresentation<T extends { presentations?: BulkPreferencePresentations }>(
  decision: T,
  language: PreferenceLanguage,
): (T & BulkPreferencePresentation) | null {
  const presentation = decision.presentations?.[language];
  return presentation ? { ...decision, ...presentation } : null;
}
