import { InputValidationError, ResultTruncationError } from "../errors";

export type FilteredPage<T> = { items: T[]; nextToken: string | undefined };

export type PaginateFilteredOptions<T> = {
  fetchPage: (
    token: string | undefined,
    maxResults: number | undefined,
  ) => Promise<{ items: T[]; nextToken: string | undefined }>;
  // predicate keeps the items that belong to the narrower listing. Omit it when
  // every item counts and the service merely caps maxResults below the page
  // being assembled: each scan then asks only for what the page still needs, so
  // the page lands exactly on maxResults with no duplicated seam.
  predicate?: (item: T) => boolean;
  nextToken: string | undefined;
  maxResults: number | undefined;
  defaultPageSize: number;
  scanPageSize?: number;
  resourceLabel: string;
};

const MAX_SCAN_REQUESTS = 101;

export class FilteredPaginator {
  static async paginate<T>({
    fetchPage,
    predicate,
    nextToken,
    maxResults,
    defaultPageSize,
    scanPageSize,
    resourceLabel,
  }: PaginateFilteredOptions<T>): Promise<FilteredPage<T>> {
    const pageSize = maxResults ?? defaultPageSize;
    if (!Number.isInteger(pageSize) || pageSize < 1) {
      throw new InputValidationError("maxResults must be a positive integer");
    }

    const results: T[] = [];
    let token = nextToken;

    for (let scan = 0; scan < MAX_SCAN_REQUESTS; scan++) {
      const requestToken = token;
      const remaining = pageSize - results.length;
      const requestSize = predicate ? scanPageSize : Math.min(scanPageSize ?? remaining, remaining);
      const page = await fetchPage(requestToken, requestSize);
      const matches = predicate ? page.items.filter(predicate) : page.items;
      results.push(...matches);

      // Landed exactly: nothing from this page is left behind, so advance past it.
      if (results.length === pageSize) {
        return { items: results, nextToken: page.nextToken };
      }

      if (results.length > pageSize) {
        // Page holds >= pageSize matches by itself. Return every match found (the
        // page may exceed maxResults) and advance past it: replaying its token would
        // loop, and skipping the surplus would drop matches — so we over-return.
        if (matches.length >= pageSize) {
          return { items: results, nextToken: page.nextToken };
        }
        // Partial page: replaying its token is safe — the taken matches just repeat.
        return { items: results.slice(0, pageSize), nextToken: requestToken };
      }

      if (page.nextToken === undefined) {
        return { items: results, nextToken: undefined };
      }
      token = page.nextToken;
    }

    throw new ResultTruncationError(
      `${resourceLabel} discovery exceeded ${MAX_SCAN_REQUESTS} scans; results are incomplete`,
    );
  }
}
