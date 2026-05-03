/**
 * SPEC-002-1-02 — DockerProbe unit tests.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { DockerProbe } from '../../../src/observation/probes/docker';
import type { DockerConnection } from '../../../src/connection/docker';

const FIX_DIR = path.join(__dirname, '..', 'fixtures');
const PLATFORM = 'docker-prod-01';

interface MockConn {
  platformId: string;
  exec: jest.Mock;
}

function mockConn(stdout: string): MockConn {
  return {
    platformId: PLATFORM,
    exec: jest.fn().mockResolvedValue({ stdout }),
  };
}

describe('DockerProbe', () => {
  test('exposes id="docker", cadence="fast", platformId from connection', () => {
    const probe = new DockerProbe(mockConn('') as unknown as DockerConnection);
    expect(probe.id).toBe('docker');
    expect(probe.cadence).toBe('fast');
    expect(probe.platformId).toBe(PLATFORM);
  });

  test('emits 2 observations from docker-events-2oom fixture', async () => {
    const stdout = await fs.readFile(path.join(FIX_DIR, 'docker-events-2oom.txt'), 'utf8');
    const probe = new DockerProbe(mockConn(stdout) as unknown as DockerConnection);
    const out = await probe.scan();
    expect(out).toHaveLength(2);
    expect(out.map((o) => o.pattern)).toEqual(['oom_kill', 'oom_kill']);
    expect(out[0]!.resource).toBe('container/redis-1');
    expect(out[0]!.severity).toBe('P1');
    expect(out[0]!.platform).toBe(PLATFORM);
    expect(out[0]!.dedup_key).toBe(`${PLATFORM}:oom_kill:container/redis-1`);
    expect(out[0]!.details).toEqual({ image: 'redis:7', time: 1714449600 });
    expect(out[1]!.resource).toBe('container/queue-2');
    expect(out[1]!.details).toEqual({ image: 'rabbit:3', time: 1714449612 });
  });

  test('returns [] on empty stream', async () => {
    const stdout = await fs.readFile(path.join(FIX_DIR, 'docker-events-empty.txt'), 'utf8');
    const probe = new DockerProbe(mockConn(stdout) as unknown as DockerConnection);
    expect(await probe.scan()).toEqual([]);
  });

  test('tolerates blank lines and trailing whitespace', async () => {
    const stdout =
      '\n  \n' +
      '{"Actor":{"Attributes":{"name":"a"}}}\n' +
      '   \n' +
      '{"Actor":{"Attributes":{"name":"b","image":"img:1"}}}\n' +
      '\n';
    const probe = new DockerProbe(mockConn(stdout) as unknown as DockerConnection);
    const out = await probe.scan();
    expect(out).toHaveLength(2);
    expect(out[0]!.resource).toBe('container/a');
    expect(out[0]!.details).toEqual({});
    expect(out[1]!.resource).toBe('container/b');
    expect(out[1]!.details).toEqual({ image: 'img:1' });
  });

  test('skips malformed JSON lines without aborting the scan', async () => {
    const stdout =
      'not-json\n' +
      '{"Actor":{"Attributes":{"name":"survivor","image":"x"}},"time":1}\n';
    const probe = new DockerProbe(mockConn(stdout) as unknown as DockerConnection);
    const out = await probe.scan();
    expect(out).toHaveLength(1);
    expect(out[0]!.resource).toBe('container/survivor');
  });

  test('skips events missing Actor.Attributes.name', async () => {
    const stdout = '{"Actor":{"Attributes":{}}}\n';
    const probe = new DockerProbe(mockConn(stdout) as unknown as DockerConnection);
    expect(await probe.scan()).toEqual([]);
  });

  test('connection error → single daemon_heartbeat_stale observation', async () => {
    const conn: MockConn = {
      platformId: PLATFORM,
      exec: jest.fn().mockRejectedValue(new Error('socket hangup')),
    };
    const probe = new DockerProbe(conn as unknown as DockerConnection);
    const out = await probe.scan();
    expect(out).toHaveLength(1);
    expect(out[0]!.pattern).toBe('daemon_heartbeat_stale');
    expect(out[0]!.severity).toBe('P0');
    expect(out[0]!.resource).toBe(`dockerd/${PLATFORM}`);
    expect(out[0]!.details).toMatchObject({
      probe: 'docker',
      reason: 'platform_unreachable',
    });
  });
});
