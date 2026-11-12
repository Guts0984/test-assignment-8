import { TEMPLATE_VARIABLES } from './schemas';

export type TemplateVariable = (typeof TEMPLATE_VARIABLES)[number];
export type TemplateValues = Readonly<Record<TemplateVariable, string>>;

const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;

/** Names used in a template that are not supported (e.g. `{{password}}`). */
export const unknownPlaceholders = (body: string): string[] => {
  const known = new Set<string>(TEMPLATE_VARIABLES);
  const bad = new Set<string>();
  for (const m of body.matchAll(PLACEHOLDER)) if (m[1] && !known.has(m[1])) bad.add(m[1]);
  return [...bad];
};

/**
 * Substitutes `{{customer_name}}` / `{{ticket_number}}`. Single pass over the TEMPLATE — values are
 * never re-scanned, so a customer named "{{ticket_number}}" cannot inject anything. Unknown names are left as-is.
 */
export const renderTemplate = (body: string, values: TemplateValues): string =>
  body.replace(PLACEHOLDER, (whole, name: string) =>
    (TEMPLATE_VARIABLES as readonly string[]).includes(name)
      ? values[name as TemplateVariable]
      : whole,
  );
