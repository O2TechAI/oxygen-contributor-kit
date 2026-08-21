export const AUTO_REMOVED_KINDS = new Set([
  "credential",
  "private-personal",
  "sensitive",
  "internal-metric",
  "internal-timeline",
  "mosaic-reidentification",
  "user_path",
  "third_party_contact",
]);

const TOP_LEVEL_FIELDS = new Set(["total", "reversible", "categories"]);
const CATEGORY_FIELDS = new Set(["kind", "count"]);

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

const validateFields = (value, allowed, label, rejectUnknown) => {
  const keys = Object.keys(value);
  const missing = [...allowed].filter((key) => !Object.hasOwn(value, key));
  if (missing.length) throw new Error(`${label} is missing fields: ${missing.join(", ")}`);
  if (rejectUnknown) {
    const unknown = keys.filter((key) => !allowed.has(key));
    if (unknown.length) throw new Error(`${label} has unknown fields`);
  }
};

export function canonicalizeAutoRemoved(value, { rejectUnknown = true } = {}) {
  if (!isObject(value)) throw new Error("auto_removed must be an object");
  validateFields(value, TOP_LEVEL_FIELDS, "auto_removed", rejectUnknown);

  const { total, reversible, categories } = value;
  if (!Number.isInteger(total) || total < 0) {
    throw new Error("auto_removed.total must be a non-negative integer");
  }
  if (typeof reversible !== "boolean") {
    throw new Error("auto_removed.reversible must be a boolean");
  }
  if (!Array.isArray(categories)) {
    throw new Error("auto_removed.categories must be an array");
  }

  const seenKinds = new Set();
  const canonicalCategories = categories.map((category, index) => {
    const label = `auto_removed.categories[${index}]`;
    if (!isObject(category)) throw new Error(`${label} must be an object`);
    validateFields(category, CATEGORY_FIELDS, label, rejectUnknown);
    const { kind, count } = category;
    if (typeof kind !== "string" || !AUTO_REMOVED_KINDS.has(kind)) {
      throw new Error(`${label}.kind is not an allowed aggregate category`);
    }
    if (seenKinds.has(kind)) throw new Error(`${label}.kind duplicates ${kind}`);
    if (!Number.isInteger(count) || count < 0) {
      throw new Error(`${label}.count must be a non-negative integer`);
    }
    seenKinds.add(kind);
    return { kind, count };
  });

  const counted = canonicalCategories.reduce((sum, category) => sum + category.count, 0);
  if (total !== counted) {
    throw new Error(`auto_removed.total ${total} does not match category total ${counted}`);
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
  return canonicalizeAutoRemoved(parsed, { rejectUnknown: false });
}
