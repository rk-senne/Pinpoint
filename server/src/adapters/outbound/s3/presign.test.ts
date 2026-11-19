import { describe, it, expect } from 'vitest';
import { presignGetUrl } from './presign.js';

describe('presignGetUrl', () => {
  it('matches the AWS documented SigV4 query-presign example', () => {
    // https://docs.aws.amazon.com/AmazonS3/latest/API/sigv4-query-string-auth.html
    const url = presignGetUrl({
      url: 'https://examplebucket.s3.amazonaws.com/test.txt',
      region: 'us-east-1',
      credentials: {
        accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
        secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      },
      expiresInSeconds: 86400,
      now: new Date('2013-05-24T00:00:00Z'),
    });
    expect(url).toBe(
      'https://examplebucket.s3.amazonaws.com/test.txt?X-Amz-Algorithm=AWS4-HMAC-SHA256' +
        '&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request' +
        '&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host' +
        '&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404',
    );
  });

  it('includes the session token when present', () => {
    const url = presignGetUrl({
      url: 'http://127.0.0.1:9000/b/k.png',
      region: 'us-east-1',
      credentials: { accessKeyId: 'a', secretAccessKey: 's', sessionToken: 'tok/+=' },
      expiresInSeconds: 60,
    });
    expect(url).toContain('X-Amz-Security-Token=tok%2F%2B%3D');
  });
});
