import { SecureCredentials } from '../credentials.js';
import { describe, expect, it } from 'vitest';

describe('SecureCredentials', () => {
  describe('constructor', () => {
    it('creates from record', () => {
      const creds = new SecureCredentials({ KEY: 'value' });
      expect(creds.get('KEY')).toBe('value');
    });

    it('creates empty when no args', () => {
      const creds = new SecureCredentials();
      expect(creds.isEmpty()).toBe(true);
      expect(creds.size).toBe(0);
    });

    it('creates empty from empty record', () => {
      const creds = new SecureCredentials({});
      expect(creds.isEmpty()).toBe(true);
    });

    it('is frozen (immutable)', () => {
      const creds = new SecureCredentials({ KEY: 'value' });
      expect(() => {
        (creds as unknown as Record<string, unknown>).newProp = 'test';
      }).toThrow();
    });
  });

  describe('get', () => {
    it('returns value for existing key', () => {
      const creds = new SecureCredentials({ API_KEY: 'sk-123' });
      expect(creds.get('API_KEY')).toBe('sk-123');
    });

    it('returns undefined for non-existent key', () => {
      const creds = new SecureCredentials({ API_KEY: 'sk-123' });
      expect(creds.get('OTHER')).toBeUndefined();
    });
  });

  describe('has', () => {
    it('returns true for existing key', () => {
      const creds = new SecureCredentials({ KEY: 'val' });
      expect(creds.has('KEY')).toBe(true);
    });

    it('returns false for non-existent key', () => {
      const creds = new SecureCredentials({ KEY: 'val' });
      expect(creds.has('OTHER')).toBe(false);
    });
  });

  describe('size', () => {
    it('returns 0 for empty', () => {
      expect(new SecureCredentials().size).toBe(0);
    });

    it('returns correct count', () => {
      expect(new SecureCredentials({ A: '1', B: '2', C: '3' }).size).toBe(3);
    });
  });

  describe('isEmpty', () => {
    it('returns true for empty credentials', () => {
      expect(new SecureCredentials().isEmpty()).toBe(true);
    });

    it('returns false for non-empty credentials', () => {
      expect(new SecureCredentials({ K: 'v' }).isEmpty()).toBe(false);
    });
  });

  describe('keys', () => {
    it('returns all key names', () => {
      const creds = new SecureCredentials({ A: '1', B: '2' });
      expect(creds.keys()).toEqual(expect.arrayContaining(['A', 'B']));
      expect(creds.keys()).toHaveLength(2);
    });

    it('returns empty array for empty credentials', () => {
      expect(new SecureCredentials().keys()).toEqual([]);
    });
  });

  describe('merge', () => {
    it('merges two SecureCredentials instances', () => {
      const a = new SecureCredentials({ KEY1: 'val1' });
      const b = new SecureCredentials({ KEY2: 'val2' });
      const merged = a.merge(b);

      expect(merged.get('KEY1')).toBe('val1');
      expect(merged.get('KEY2')).toBe('val2');
      expect(merged.size).toBe(2);
    });

    it('merges with plain object', () => {
      const creds = new SecureCredentials({ KEY1: 'val1' });
      const merged = creds.merge({ KEY2: 'val2' });

      expect(merged.get('KEY1')).toBe('val1');
      expect(merged.get('KEY2')).toBe('val2');
    });

    it('new values take precedence', () => {
      const a = new SecureCredentials({ KEY: 'old' });
      const b = new SecureCredentials({ KEY: 'new' });
      const merged = a.merge(b);

      expect(merged.get('KEY')).toBe('new');
    });

    it('returns new instance (immutable)', () => {
      const a = new SecureCredentials({ KEY: 'val' });
      const merged = a.merge({});

      expect(merged).not.toBe(a);
      expect(merged).toBeInstanceOf(SecureCredentials);
    });
  });

  describe('toPlainObject', () => {
    it('returns plain record with actual values', () => {
      const creds = new SecureCredentials({ API_KEY: 'secret', TOKEN: 'tok' });
      const plain = creds.toPlainObject();

      expect(plain).toEqual({ API_KEY: 'secret', TOKEN: 'tok' });
    });

    it('returns empty object for empty credentials', () => {
      expect(new SecureCredentials().toPlainObject()).toEqual({});
    });
  });

  describe('security (serialization safety)', () => {
    it('toJSON redacts values', () => {
      const creds = new SecureCredentials({ SECRET: 'hidden', TOKEN: 'also-hidden' });
      const json = creds.toJSON();

      expect(json._redacted).toBe('[CREDENTIALS REDACTED]');
      expect(json.count).toBe(2);
      expect(json.keys).toEqual(expect.arrayContaining(['SECRET', 'TOKEN']));
      // Verify actual values are NOT in the JSON
      expect(JSON.stringify(json)).not.toContain('hidden');
    });

    it('JSON.stringify does not expose values', () => {
      const creds = new SecureCredentials({ SECRET: 'mypassword' });
      const serialized = JSON.stringify(creds);

      expect(serialized).not.toContain('mypassword');
      expect(serialized).toContain('REDACTED');
    });

    it('toString is safe', () => {
      const creds = new SecureCredentials({ SECRET: 'mypassword' });
      const str = creds.toString();

      expect(str).not.toContain('mypassword');
      expect(str).toContain('1 credential(s)');
    });

    it('Node.js inspect is safe', () => {
      const creds = new SecureCredentials({ SECRET: 'mypassword' });
      const inspectFn = (creds as any)[Symbol.for('nodejs.util.inspect.custom')] as () => string;
      const str = inspectFn.call(creds);

      expect(str).not.toContain('mypassword');
    });
  });

  describe('static factories', () => {
    it('fromEnvVars creates from record', () => {
      const creds = SecureCredentials.fromEnvVars({ KEY: 'val' });
      expect(creds.get('KEY')).toBe('val');
      expect(creds).toBeInstanceOf(SecureCredentials);
    });

    it('empty creates empty instance', () => {
      const creds = SecureCredentials.empty();
      expect(creds.isEmpty()).toBe(true);
      expect(creds).toBeInstanceOf(SecureCredentials);
    });
  });
});
