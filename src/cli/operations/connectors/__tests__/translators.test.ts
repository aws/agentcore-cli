import { translateConnector } from '../translators';
import { describe, expect, it } from 'vitest';

/** The single WebSearch entry the web-search connector always produces. */
function webSearch(input: { includeDomains?: string[]; excludeDomains?: string[] }) {
  const entries = translateConnector({ connectorId: 'web-search', input });
  expect(entries).toHaveLength(1);
  expect(entries[0]?.name).toBe('WebSearch');
  return entries[0]!;
}

describe('translateConnector — web-search', () => {
  it('emits no domainFilter when neither list is given', () => {
    expect(webSearch({}).parameterValues).toEqual({});
  });

  it('emits an exclude-only filter', () => {
    expect(webSearch({ excludeDomains: ['internal.example.com'] }).parameterValues).toEqual({
      domainFilter: { exclude: ['internal.example.com'] },
    });
  });

  it('emits an include-only filter', () => {
    expect(webSearch({ includeDomains: ['docs.aws.amazon.com'] }).parameterValues).toEqual({
      domainFilter: { include: ['docs.aws.amazon.com'] },
    });
  });

  it('puts both lists in one domainFilter, since the connector reads them together', () => {
    expect(
      webSearch({ includeDomains: ['aws.amazon.com'], excludeDomains: ['internal.example.com'] }).parameterValues
    ).toEqual({
      domainFilter: { include: ['aws.amazon.com'], exclude: ['internal.example.com'] },
    });
  });

  it('drops empty lists rather than sending them', () => {
    // An empty include list is not the same request as no include list: sending one
    // would tell the connector to return nothing.
    expect(webSearch({ includeDomains: [], excludeDomains: [] }).parameterValues).toEqual({});
  });

  it('keeps one list when the other is empty', () => {
    expect(webSearch({ includeDomains: ['aws.amazon.com'], excludeDomains: [] }).parameterValues).toEqual({
      domainFilter: { include: ['aws.amazon.com'] },
    });
  });
});
