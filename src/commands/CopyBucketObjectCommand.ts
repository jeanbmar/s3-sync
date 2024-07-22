import {
  CopyObjectCommand,
  CopyObjectCommandInput,
  S3Client,
} from '@aws-sdk/client-s3';
import { AbortSignal } from '@aws-sdk/abort-controller';
import { TransferMonitor } from '../TransferMonitor';
import { BucketObject } from '../fs/BucketObject';
import { CommandInput, mergeInput } from './Command';

export type CopyBucketObjectCommandInput = {
  bucketObject: BucketObject;
  targetBucket: string;
  abortSignal?: AbortSignal;
  commandInput?: CommandInput<CopyObjectCommandInput>;
  monitor?: TransferMonitor;
};

export class CopyBucketObjectCommand {
  bucketObject: BucketObject;
  targetBucket: string;
  abortSignal?: AbortSignal;
  commandInput?: CommandInput<CopyObjectCommandInput>;
  monitor?: TransferMonitor;

  constructor(input: CopyBucketObjectCommandInput) {
    this.bucketObject = input.bucketObject;
    this.targetBucket = input.targetBucket;
    this.abortSignal = input.abortSignal;
    this.commandInput = input.commandInput;
    this.monitor = input.monitor;
  }

  async execute(client: S3Client): Promise<void> {
    const commandInput = mergeInput<CopyObjectCommandInput>(
      {
        Bucket: this.targetBucket,
        Key: this.bucketObject.id,
        CopySource: encodeURIComponent(
          `${this.bucketObject.bucket}/${this.bucketObject.key}`
        ),
      },
      this.commandInput
    );
    await client.send(new CopyObjectCommand(commandInput), {
      abortSignal: this.abortSignal,
    });
    if (this.monitor) {
      this.monitor.emit('size', this.bucketObject.size);
      this.monitor.emit('object');
    }
  }
}
