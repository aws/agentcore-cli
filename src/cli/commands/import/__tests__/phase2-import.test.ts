import { publishCdkAssets } from '../phase2-import';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { unzipSync } from 'fflate';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { type MockInstance, afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../../aws/account', () => ({
  getCredentialProvider: () => ({
    accessKeyId: 'test',
    secretAccessKey: 'test',
  }),
}));

describe('publishCdkAssets', () => {
  let assemblyDirectory: string;
  let sendSpy: MockInstance;

  beforeEach(() => {
    assemblyDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'import-assets-'));
    sendSpy = vi.spyOn(S3Client.prototype, 'send').mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(assemblyDirectory, { recursive: true, force: true });
  });

  function writeManifest(assetPath: string) {
    fs.writeFileSync(
      path.join(assemblyDirectory, 'stack.assets.json'),
      JSON.stringify({
        files: {
          asset: {
            source: { path: assetPath, packaging: 'zip' },
            destinations: {
              target: { bucketName: 'test-assets', objectKey: 'asset.zip', region: 'us-east-1' },
            },
          },
        },
      })
    );
  }

  test.each([
    { assetPath: 'asset', relativeAssembly: false },
    { assetPath: 'asset with spaces', relativeAssembly: false },
    { assetPath: 'asset & (copy)', relativeAssembly: false },
    { assetPath: 'asset $(echo literal)', relativeAssembly: false },
    { assetPath: 'asset `echo literal`', relativeAssembly: false },
    { assetPath: 'asset with spaces', relativeAssembly: true },
  ])(
    'uploads directory contents for $assetPath (relative assembly: $relativeAssembly)',
    async ({ assetPath, relativeAssembly }) => {
      const sourcePath = path.join(assemblyDirectory, assetPath);
      fs.mkdirSync(path.join(sourcePath, 'nested'), { recursive: true });
      fs.writeFileSync(path.join(sourcePath, 'main.py'), 'print("hello")\n');
      fs.writeFileSync(path.join(sourcePath, 'nested', 'data.txt'), 'asset data');
      writeManifest(assetPath);

      await publishCdkAssets(
        relativeAssembly ? path.relative(process.cwd(), assemblyDirectory) : assemblyDirectory,
        'us-east-1'
      );

      expect(sendSpy).toHaveBeenCalledTimes(1);
      const command = sendSpy.mock.calls[0]![0] as PutObjectCommand;
      expect(command).toBeInstanceOf(PutObjectCommand);
      expect(command.input).toMatchObject({ Bucket: 'test-assets', Key: 'asset.zip' });
      const files = unzipSync(command.input.Body as Buffer);
      expect(Buffer.from(files['main.py']!).toString()).toBe('print("hello")\n');
      expect(Buffer.from(files['nested/data.txt']!).toString()).toBe('asset data');
      expect(fs.existsSync(`${sourcePath}.zip`)).toBe(false);
    }
  );

  test('rejects without uploading when zip fails', async () => {
    fs.mkdirSync(path.join(assemblyDirectory, 'empty-asset'));
    writeManifest('empty-asset');

    await expect(publishCdkAssets(assemblyDirectory, 'us-east-1')).rejects.toThrow();

    expect(sendSpy).not.toHaveBeenCalled();
  });
});
