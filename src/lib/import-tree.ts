type TreeImport = { path: string; title: string };

export type ImportFolder<T extends TreeImport = TreeImport> = {
  name: string;
  path: string;
  folders: ImportFolder<T>[];
  items: T[];
};

/** Nests imports by path: folders first, then files, each sorted; a folder
 * holding only one folder merges into it (`docs/guides`) to save a click. */
export function importTree<T extends TreeImport>(
  imports: T[],
): ImportFolder<T> {
  const root: ImportFolder<T> = { name: "", path: "", folders: [], items: [] };
  for (const item of imports) {
    let folder: ImportFolder<T> = root;
    for (const name of item.path.split("/").slice(0, -1)) {
      let next = folder.folders.find((child) => child.name === name);
      if (!next) {
        next = {
          name,
          path: folder.path ? `${folder.path}/${name}` : name,
          folders: [],
          items: [],
        };
        folder.folders.push(next);
      }
      folder = next;
    }
    folder.items.push(item);
  }
  const tidy = (folder: ImportFolder<T>): ImportFolder<T> => {
    const folders = folder.folders.map((child) => {
      let merged = tidy(child);
      while (!merged.items.length && merged.folders.length === 1) {
        const only = merged.folders[0];
        merged = { ...only, name: `${merged.name}/${only.name}` };
      }
      return merged;
    }).sort((left, right) => left.name.localeCompare(right.name));
    const items = [...folder.items].sort((left, right) =>
      left.title.localeCompare(right.title)
    );
    return { ...folder, folders, items };
  };
  return tidy(root);
}

export const folderSize = (folder: ImportFolder): number =>
  folder.items.length +
  folder.folders.reduce((total, child) => total + folderSize(child), 0);
