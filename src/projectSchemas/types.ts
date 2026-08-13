export type FilePath = string & {
  readonly __brand: "FilePath";
};
export type DirectoryPath = string & {
  readonly __brand: "DirectoryPath";
};
