/** A plugin's element reads under its plugin's name: `law-firm/Drafting`. */
export const qualifiedName = (plugin: string | null, name: string): string => (plugin === null ? name : `${plugin}/${name}`);

/** A marketplace as the owner types it: a Git URL, or GitHub's `owner/repo`. The page fills its form with the same. */
export function marketplaceUrl(input: string): string {
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input) ? `https://github.com/${input.replace(/\.git$/, "")}.git` : input;
}
