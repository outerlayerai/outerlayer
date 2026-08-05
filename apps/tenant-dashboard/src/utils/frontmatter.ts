import yaml from "js-yaml";

// eslint-disable-next-line import/no-unused-modules -- Type exported for consumers of parseFrontMatter
export interface FrontMatterResult<T = Record<string, unknown>> {
  attributes: T;
  body: string;
}

/**
 * Parse frontmatter from a string.
 * Compatible with js-yaml 4.x (uses yaml.load instead of deprecated safeLoad).
 *
 * @param content - String content with optional YAML frontmatter between --- delimiters
 * @returns Object with parsed attributes and body content
 */
export function parseFrontMatter<T = Record<string, unknown>>(
  content: string
): FrontMatterResult<T> {
  const frontMatterRegex = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n)?([\s\S]*)$/;
  const match = content.match(frontMatterRegex);

  if (!match) {
    return {
      attributes: {} as T,
      body: content,
    };
  }

  const [, frontMatterStr, body] = match;

  try {
    const attributes = (yaml.load(frontMatterStr || "") as T) || ({} as T);
    return {
      attributes,
      body: body || "",
    };
  } catch (error) {
    throw new Error(
      `Failed to parse frontmatter: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
