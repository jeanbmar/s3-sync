/* eslint-disable func-names */
const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const assert = require('assert');
const tar = require('tar');
const { describe, it } = require('mocha');
const { GetObjectAclCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const S3SyncClient = require('..');
const SyncObject = require('../lib/objects/sync-object');
const LocalObject = require('../lib/objects/local-object');

const BUCKET = 's3-sync-client';
const BUCKET_2 = 's3-sync-client-2';
const ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID;
const SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY;
const DATA_DIR = path.join(__dirname, 'data');
const SYNC_DIR = path.join(__dirname, 'sync');

describe('S3SyncClient', () => {
    let s3;

    before(() => {
        s3 = new S3SyncClient({
            region: 'eu-west-3',
            credentials: { accessKeyId: ACCESS_KEY_ID, secretAccessKey: SECRET_ACCESS_KEY },
        });
    });

    it('load initial data folder', async function () {
        this.timeout(20000);
        fs.rmSync(DATA_DIR, { force: true, recursive: true });
        fs.mkdirSync(DATA_DIR, { recursive: true });
        await tar.x({
            file: path.join(__dirname, 'sample-files.tar.gz'),
            cwd: DATA_DIR,
        });
    });

    it('load bucket 2 dataset', async function () {
        this.timeout(180000);
        const monitor = new EventEmitter();
        monitor.on('progress', (progress) => console.log(progress));
        await s3.emptyBucket(BUCKET_2);
        await s3.bucketWithLocal(DATA_DIR, BUCKET_2, { del: true, maxConcurrentTransfers: 1000, monitor });
        const objects = await s3.listLocalObjects(DATA_DIR);
        assert(objects.size === 10000);
    });

    it('empty bucket', async function () {
        this.timeout(20000);
        await s3.emptyBucket(BUCKET);
        const bucketObjects = await s3.listBucketObjects(BUCKET);
        assert(bucketObjects.size === 0);
    });

    describe('list local objects', () => {
        it('listed objects are properly formed', async () => {
            const objects = await s3.listLocalObjects(path.join(DATA_DIR, 'def/jkl'));
            assert.deepStrictEqual(objects.get('xmoj'), new LocalObject({
                id: 'xmoj',
                lastModified: 1618993846000,
                size: 3,
                path: path.join(DATA_DIR, 'def/jkl/xmoj'),
            }));
        });

        it('list local objects with non-directory args throws', async () => {
            await assert.rejects(async () => s3.listLocalObjects(path.join(DATA_DIR, 'xoin')));
        });
    });

    describe('get relocation id', () => {
        const getRelocation = (id, sourcePrefix, targetPrefix) => {
            const object = new SyncObject({ id });
            object.relocate(sourcePrefix, targetPrefix);
            return object.id;
        };
        it('relocate id from root', () => {
            assert.deepStrictEqual(getRelocation('', '', ''), '');
            assert.deepStrictEqual(getRelocation('id', '', ''), 'id');
            assert.deepStrictEqual(getRelocation('a/b/c', '', ''), 'a/b/c');
            assert.deepStrictEqual(getRelocation('a/b/c', '', 'x'), 'x/a/b/c');
            assert.deepStrictEqual(getRelocation('a/b/c', '', 'x/y'), 'x/y/a/b/c');
        });
        it('relocate id to root', () => {
            assert.deepStrictEqual(getRelocation('a/b/c', 'a', ''), 'b/c');
            assert.deepStrictEqual(getRelocation('a/b/c', 'a/b', ''), 'c');
        });
        it('folder is not relocated', () => {
            assert.deepStrictEqual(getRelocation('a/b/c', 'a/b/c', ''), 'a/b/c');
        });
        it('perform complex id relocation', () => {
            assert.deepStrictEqual(getRelocation('a/b/c', 'a', 'x'), 'x/b/c');
            assert.deepStrictEqual(getRelocation('a/b/c', 'a', 'x/y/z'), 'x/y/z/b/c');
            assert.deepStrictEqual(getRelocation('a/b/c', 'a/b', 'x'), 'x/c');
            assert.deepStrictEqual(getRelocation('a/b/c', 'a/b', 'x/y'), 'x/y/c');
            assert.deepStrictEqual(getRelocation('x/y/z', 'x/y', ''), 'z');
        });
    });

    describe('sync bucket with bucket', function () {
        this.timeout(120000);

        it('sync a single dir with progress tracking', async () => {
            const monitor = new EventEmitter();
            monitor.on('progress', (progress) => console.log(progress));
            await s3.bucketWithBucket(`${BUCKET_2}/def/jkl`, BUCKET, { maxConcurrentTransfers: 1000, monitor });
            const objects = await s3.listBucketObjects(BUCKET, { prefix: 'def/jkl' });
            assert(objects.has('def/jkl/xmoj'));
            assert(objects.size === 11);
        });

        it('sync a single dir with root relocation', async () => {
            await s3.bucketWithBucket(`${BUCKET_2}/def/jkl`, BUCKET, {
                maxConcurrentTransfers: 1000,
                relocations: [['', 'relocated']],
            });
            const objects = await s3.listBucketObjects(BUCKET, { prefix: 'relocated' });
            assert(objects.has('relocated/def/jkl/xmoj'));
            assert(objects.size === 11);
        });

        it('sync a single dir with folder relocation', async () => {
            await s3.bucketWithBucket(`${BUCKET_2}/def/jkl`, BUCKET, {
                maxConcurrentTransfers: 1000,
                relocations: [['def/jkl', 'relocated-bis/folder']],
            });
            const objects = await s3.listBucketObjects(BUCKET, { prefix: 'relocated-bis/folder' });
            assert(objects.has('relocated-bis/folder/xmoj'));
            assert(objects.size === 11);
        });

        it('sync entire bucket with delete option successfully', async () => {
            await s3.bucketWithBucket(BUCKET_2, BUCKET, { del: true, maxConcurrentTransfers: 1000 });
            const objects = await s3.listBucketObjects(BUCKET);
            assert(objects.size === 10000);
        });
    });

    describe('sync bucket with local', function () {
        this.timeout(120000);

        it('sync a single dir with a few files successfully', async () => {
            await s3.bucketWithLocal(path.join(DATA_DIR, 'def/jkl'), BUCKET);
            const objects = await s3.listBucketObjects(BUCKET);
            assert(objects.has('xmoj'));
        });

        it('sync a single dir with a bucket using relocation successfully', async () => {
            await s3.bucketWithLocal(
                path.join(DATA_DIR, 'def/jkl'),
                path.posix.join(BUCKET, 'zzz'),
                { relocations: [['', 'zzz']] },
            );
            const objects = await s3.listBucketObjects(BUCKET, { prefix: 'zzz' });
            assert(objects.has('zzz/zzz/xmoj'));
        });

        it('sync files with extra SDK command input options successfully', async () => {
            await s3.bucketWithLocal(
                path.join(DATA_DIR, 'def/jkl'),
                path.posix.join(BUCKET, 'acl'),
                {
                    commandInput: {
                        ACL: 'aws-exec-read',
                        Metadata: (syncCommandInput) => ({ custom: syncCommandInput.Key }),
                    },
                },
            );
            const metadataResponse = await s3.send(new GetObjectCommand({
                Bucket: BUCKET,
                Key: 'acl/xmoj',
            }));
            assert(metadataResponse.Metadata.custom === 'acl/xmoj');
            const aclResponse = await s3.send(new GetObjectAclCommand({
                Bucket: BUCKET,
                Key: 'acl/xmoj',
            }));
            assert(aclResponse.Grants.findIndex(({ Permission }) => Permission === 'FULL_CONTROL') > -1);
            assert(aclResponse.Grants.findIndex(({ Permission }) => Permission === 'READ') > -1);
        });

        it('sync 10000 local objects successfully with progress tracking', async () => {
            const monitor = new EventEmitter();
            monitor.on('progress', (progress) => console.log(progress));
            await s3.bucketWithLocal(DATA_DIR, BUCKET, { maxConcurrentTransfers: 1000, monitor });
            const objects = await s3.listLocalObjects(DATA_DIR);
            assert(objects.size >= 10000);
        });

        it('sync 10000 local objects with delete option successfully', async () => {
            await s3.bucketWithLocal(path.join(DATA_DIR, 'def/jkl'), BUCKET);
            await s3.bucketWithLocal(DATA_DIR, BUCKET, { del: true, maxConcurrentTransfers: 1000 });
            const objects = await s3.listLocalObjects(DATA_DIR);
            assert(objects.size === 10000);
            assert(!objects.has('xmoj'));
        });
    });

    describe('sync local with bucket', function () {
        this.timeout(120000);

        before(() => {
            fs.mkdirSync(path.join(__dirname, 'sync'), { recursive: true });
        });

        it('sync a single dir with a few files successfully', async () => {
            await s3.localWithBucket(`${BUCKET_2}/def/jkl`, SYNC_DIR);
            const objects = await s3.listLocalObjects(SYNC_DIR);
            assert(objects.has('def/jkl/xmoj'));
        });

        it('sync a single dir and flatten it', async () => {
            await s3.localWithBucket(`${BUCKET_2}/def/jkl`, SYNC_DIR, { flatten: true });
            const objects = await s3.listLocalObjects(SYNC_DIR);
            assert(objects.has('xmoj'));
        });

        it('sync 10000 bucket objects successfully with progress tracking', async () => {
            const monitor = new EventEmitter();
            monitor.on('progress', (progress) => console.log(progress));
            await s3.localWithBucket(BUCKET_2, SYNC_DIR, { maxConcurrentTransfers: 1000, monitor });
            const objects = await s3.listLocalObjects(SYNC_DIR);
            assert(objects.size >= 10000);
        });

        it('sync 10000 bucket objects with delete option successfully', async () => {
            await s3.localWithBucket(`${BUCKET_2}/def/jkl`, path.join(SYNC_DIR, 'foo'));
            await s3.localWithBucket(BUCKET_2, SYNC_DIR, { del: true, maxConcurrentTransfers: 1000 });
            const objects = await s3.listLocalObjects(SYNC_DIR);
            assert(objects.size === 10000);
            assert(!objects.has('foo/def/jkl/xmoj'));
        });

        it('abort sync and throw', async () => {
            const monitor = new EventEmitter();
            const pSync = s3.localWithBucket(BUCKET_2, path.join(SYNC_DIR, 'abort'), { monitor });
            monitor.on('progress', () => monitor.emit('abort'));
            await assert.rejects(pSync, { name: 'AbortError' });
        });
    });

    describe('compute sync operations', () => {
        const bucketObjects = new Map([
            ['abc/created', { id: 'abc/created', lastModified: 0, size: 1 }],
            ['abc/updated1', { id: 'abc/updated1', lastModified: 1, size: 1 }],
            ['abc/updated2', { id: 'abc/updated2', lastModified: 0, size: 2 }],
            ['abc/unchanged', { id: 'abc/unchanged', lastModified: 0, size: 1 }],
        ]);
        const localObjects = new Map([
            ['abc/unchanged', { id: 'abc/unchanged', lastModified: 0, size: 1 }],
            ['abc/updated1', { id: 'abc/updated1', lastModified: 0, size: 1 }],
            ['abc/updated2', { id: 'abc/updated2', lastModified: 0, size: 1 }],
            ['deleted', { id: 'deleted', lastModified: 0, size: 1 }],
        ]);

        it('compute sync operations on objects successfully', () => {
            const { created, updated, deleted } = S3SyncClient.util.diff(bucketObjects, localObjects);
            assert.deepStrictEqual(created, [
                { id: 'abc/created', size: 1, lastModified: 0 },
            ]);
            assert.deepStrictEqual(updated, [
                { id: 'abc/updated1', size: 1, lastModified: 1 },
                { id: 'abc/updated2', size: 2, lastModified: 0 },
            ]);
            assert.deepStrictEqual(deleted, [
                { id: 'deleted', size: 1, lastModified: 0 },
            ]);
        });
    });
});
