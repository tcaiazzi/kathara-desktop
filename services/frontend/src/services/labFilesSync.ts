import type { FsTreeSource } from "../hooks/useFsTree";

/** The latest change a file tree made to the open lab's folder; `origin` is that tree's scope key,
 *  and `seq` makes a repeat from the same tree a new value. */
export interface LabFilesChange {
  origin: string;
  seq: number;
}

/** `source`, calling `notify` after each of its operations that changes the disk succeeds. The
 *  Lab Configuration tree and every device's Files tab read the same lab folder, so each one
 *  announces its own changes for the others to re-read (hooks/useLabFilesSync.ts). */
export function withChangeNotice(source: FsTreeSource, notify: () => void): FsTreeSource {
  const after =
    <A extends unknown[]>(op: (...args: A) => Promise<void>) =>
    async (...args: A) => {
      await op(...args);
      notify();
    };
  return {
    ...source,
    writeText: after(source.writeText),
    mkdir: after(source.mkdir),
    move: after(source.move),
    copy: after(source.copy),
    remove: after(source.remove),
    upload: after(source.upload),
  };
}
