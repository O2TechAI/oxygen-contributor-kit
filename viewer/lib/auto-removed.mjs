export const AUTO_REMOVED_KINDS = new Set([
  "credential",
  "private-personal",
  "sensitive",
  "internal-metric",
  "internal-timeline",
  "mosaic-reidentification",
]);

const TOP_LEVEL_FIELDS = new Set(["total", "reversible", "categories"]);
const CATEGORY_FIELDS = new Set(["kind", "count"]);

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

const validateFields = (value, allowed, label) => {
  const keys = Object.keys(value);
  const missing = [...allowed].filter((key) => !Object.hasOwn(value, key));
  if (missing.length) throw new Error(`${label} is missing fields: ${missing.join(", ")}`);
  const unknown = keys.filter((key) => !allowed.has(key));
  if (unknown.length) throw new Error(`${label} has unknown fields`);
};

export function canonicalizeAutoRemoved(value) {
  if (!isObject(value)) throw new Error("auto_removed must be an object");
  validateFields(value, TOP_LEVEL_FIELDS, "auto_removed");

  const { total, reversible, categories } = value;
  if (!Number.isSafeInteger(total) || total < 0) {
    throw new Error("auto_removed.total must be a non-negative safe integer");
  }
  if (reversible !== true) {
    throw new Error("auto_removed.reversible must be true");
  }
  if (!Array.isArray(categories)) {
    throw new Error("auto_removed.categories must be an array");
  }

  const seenKinds = new Set();
  const canonicalCategories = categories.map((category, index) => {
    const label = `auto_removed.categories[${index}]`;
    if (!isObject(category)) throw new Error(`${label} must be an object`);
    validateFields(category, CATEGORY_FIELDS, label);
    const { kind, count } = category;
    if (typeof kind !== "string" || !AUTO_REMOVED_KINDS.has(kind)) {
      throw new Error(`${label}.kind is not an allowed aggregate category`);
    }
    if (seenKinds.has(kind)) throw new Error(`${label}.kind duplicates ${kind}`);
    if (!Number.isSafeInteger(count) || count <= 0) {
      throw new Error(`${label}.count must be a positive safe integer`);
    }
    seenKinds.add(kind);
    return { kind, count };
  });

  const counted = canonicalCategories.reduce((sum, category) => sum + category.count, 0);
  if (total !== counted) {
    throw new Error(`auto_removed.total ${total} does not match category total ${counted}`);
  }
  const kinds = canonicalCategories.map((category) => category.kind);
  if (kinds.some((kind, index) => index > 0 && kinds[index - 1] >= kind)) {
    throw new Error("auto_removed.categories must be in UTF-8 kind order");
  }
  return { total, reversible, categories: canonicalCategories };
}

export function canonicalizeStoredAutoRemoved(serialized) {
  let parsed;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw new Error("stored auto_removed is not valid JSON");
  }
  return canonicalizeAutoRemoved(parsed);
}
