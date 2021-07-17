const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const EventEmitter = require('events');
const { AbortController } = require('@aws-sdk/abort-controller');
const {
    GetObjectCommand,
    PutObjectCommand,
    CopyObjectCommand,
} = require('@aws-sdk/client-s3');
const { DEFAULT_MAX_CONCURRENT_TRANSFERS } = require('./constants');
const TransferStatus = require('./transfer-status');

class TransferManager {
    constructor(options = {}) {
        const {
            client,
            commandInput = {},
            maxConcurrentTransfers = DEFAULT_MAX_CONCURRENT_TRANSFERS,
            monitor = new EventEmitter(),
        } = options;
        this.client = client;
        this.commandInput = commandInput;
        this.maxConcurrentTransfers = maxConcurrentTransfers;
        this.abortController = new AbortController();
        this.monitor = monitor;
        this.monitor.on('abort', () => this.abort());
    }

    abort() {
        this.abortController.abort();
    }

    setSdkCommandInputOptions(syncCommandInput) {
        Object.entries(this.commandInput).forEach(([propertyName, propertyValue]) => {
            syncCommandInput[propertyName] = typeof propertyValue === 'function'
                ? propertyValue(syncCommandInput)
                : propertyValue;
        });
    }

    async download(commands) {
        const status = new TransferStatus(commands);
        while (status.currentCount < status.totalCount) {
            const chunk = commands.slice(status.currentCount, status.currentCount + this.maxConcurrentTransfers);
            await Promise.all(chunk.map(async ({ path: filePath, key, bucket }) => {
                await fsp.mkdir(path.dirname(filePath), { recursive: true });
                const getObjectCommandInput = {
                    Bucket: bucket,
                    Key: key,
                };
                this.setSdkCommandInputOptions(getObjectCommandInput);
                const { Body: readStream } = await this.client.send(
                    new GetObjectCommand(getObjectCommandInput),
                    { abortSignal: this.abortController.signal },
                );
                const writeStream = readStream.pipe(fs.createWriteStream(filePath));
                readStream.on('data', (data) => {
                    status.currentSize += data.length;
                    this.monitor.emit('progress', status.getProgress());
                });
                writeStream.on('finish', () => {
                    status.currentCount += 1;
                    this.monitor.emit('progress', status.getProgress());
                });
                return new Promise((resolve, reject) => {
                    writeStream.on('error', reject);
                    writeStream.on('finish', resolve);
                });
            }));
        }
        return status.currentCount;
    }

    async upload(commands) {
        const status = new TransferStatus(commands);
        while (status.currentCount < status.totalCount) {
            const chunk = commands.slice(status.currentCount, status.currentCount + this.maxConcurrentTransfers);
            await Promise.all(chunk.map(async ({ key, bucket, path: filePath }) => {
                const stream = fs.createReadStream(filePath);
                stream.on('data', (data) => {
                    status.currentSize += data.length;
                    this.monitor.emit('progress', status.getProgress());
                });
                // attaching data event set stream status to flowing, we need to restore the status to paused
                stream.pause();
                stream.on('end', () => {
                    status.currentCount += 1;
                    this.monitor.emit('progress', status.getProgress());
                });
                const upload = new Promise((resolve, reject) => {
                    stream.on('error', reject);
                    stream.on('end', resolve);
                });
                const putObjectCommandInput = {
                    Bucket: bucket,
                    Key: key,
                    Body: stream,
                };
                this.setSdkCommandInputOptions(putObjectCommandInput);
                await this.client.send(
                    new PutObjectCommand(putObjectCommandInput),
                    { abortSignal: this.abortController.signal },
                );
                return upload;
            }));
        }
        return status.currentCount;
    }

    async copy(commands) {
        const status = new TransferStatus(commands);
        while (status.currentCount < status.totalCount) {
            const chunk = commands.slice(status.currentCount, status.currentCount + this.maxConcurrentTransfers);
            // eslint-disable-next-line object-curly-newline
            await Promise.all(chunk.map(async ({ key, bucket, sourceKey, sourceBucket, size }) => {
                const copyObjectCommandInput = {
                    Bucket: bucket,
                    Key: key,
                    CopySource: encodeURI(`${sourceBucket}/${sourceKey}`),
                };
                this.setSdkCommandInputOptions(copyObjectCommandInput);
                await this.client.send(
                    new CopyObjectCommand(copyObjectCommandInput),
                    { abortSignal: this.abortController.signal },
                );
                status.currentSize += size;
                status.currentCount += 1;
                this.monitor.emit('progress', status.getProgress());
            }));
        }
        return status.currentCount;
    }
}

module.exports = TransferManager;
