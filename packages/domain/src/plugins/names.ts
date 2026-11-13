/** A plugin's element reads under its plugin's name: `law-firm/Drafting`. */
export const qualifiedName = (plugin: string | null, name: string): string => (plugin === null ? name : `${plugin}/${name}`);
