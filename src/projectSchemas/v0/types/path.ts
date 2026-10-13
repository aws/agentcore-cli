/**
 * Path type definitions for schema fields.
 *
 * These types indicate whether a string field represents a file path or directory path,
 * enabling the UI to render appropriate path completion (files vs directories only).
 */
import { z } from 'zod';

// Path type markers for schema fields
export const PathTypeSchema = z.enum(['file', 'directory']);
export type PathType = z.infer<typeof PathTypeSchema>;

/**
 * Branded type for file path strings.
 * Used to indicate a schema field expects a path to a file.
 */
export type FilePath = string & { readonly __brand: 'FilePath' };

/**
 * Branded type for directory path strings.
 * Used to indicate a schema field expects a path to a directory.
 */
export type DirectoryPath = string & { readonly __brand: 'DirectoryPath' };
