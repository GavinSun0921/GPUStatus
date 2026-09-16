/**
 * Validation for the on-disk configuration file (`config/hosts.json`).
 *
 * This validates the FILE. It deliberately applies no defaults and renames
 * nothing: `loadConfig` keeps the document as written (`raw`) so that an admin
 * -page save can re-emit sections it does not edit without substituting
 * resolved values. Normalisation into camelCase internal fields happens after
 * validation, in `loadConfig`.
 *
 * Every object is `.loose()` so unknown keys survive. Dropping them would
 * silently delete anything the serializer is supposed to preserve -- comments
 * are already gone by this point, but a hand-added key would vanish on the next
 * save.
 *
 * Two improvements over the hand-written checks it replaces:
 *
 *   - ALL problems are reported at once. The old code threw on the first
 *     `fail()`, so fixing a config file meant one restart per mistake.
 *   - Each message carries the JSON path (`hosts[2].disks[0]`), so a 100-line
 *     config file does not have to be searched by eye.
 */

import { z } from 'zod';

/** A directory path as it must appear on the GPU machine. */
const absolutePath = z
  .string()
  .trim()
  .min(1, '不能为空')
  .refine((p) => p.startsWith('/'), '必须是绝对路径(以 / 开头)')
  .refine((p) => !p.includes('\n'), '不能包含换行符');

/**
 * A number with a floor, truncated toward zero.
 *
 * Coerces from string so a hand-written `"interval_ms": "5000"` still works,
 * matching the leniency the previous implementation had, and truncates the way
 * it did (`Math.trunc`) rather than rejecting a fractional value.
 */
const intAtLeast = (min: number) =>
  z
    .coerce.number({ error: '必须是一个数字' })
    .refine((n) => Number.isFinite(n), '必须是一个有限数字')
    .transform((n) => Math.trunc(n))
    .refine((n) => n >= min, `必须 >= ${min}`);

const nonEmptyString = (label: string) =>
  z.string({ error: `缺少 ${label}` }).trim().min(1, `${label} 不能为空`);

export const RawHostSchema = z.looseObject({
  id: nonEmptyString('id')
    .refine(
      (id) => /^[A-Za-z0-9._@-]+$/.test(id),
      '只能包含字母、数字、点、短横线、下划线',
    ),
  ssh: nonEmptyString('ssh'),
  label: z.string({ error: 'label 必须是字符串' }).nullish(),
  group: z.string({ error: 'group 必须是字符串' }).nullish(),
  expect_gpus: intAtLeast(0).nullish(),
  /**
   * Three distinct states, and the difference matters:
   *   key absent  -> never configured, so show EVERY discovered filesystem
   *   []          -> explicitly ticked nothing, so show none
   *   ["/home"]   -> show exactly these
   */
  disks: z.array(absolutePath, { error: '必须是路径数组' }).nullish(),
  /** network mounts to health-check; their capacity belongs to the file server */
  net_mounts: z.array(absolutePath, { error: '必须是路径数组' }).nullish(),
  note: z.string({ error: 'note 必须是字符串' }).nullish(),
});

export const RawConfigSchema = z
  .looseObject({
    site: z.string({ error: 'site 必须是字符串' }).nullish(),
    announcement: z
      .looseObject({
        enabled: z.boolean().nullish(),
        level: z.enum(['info', 'warning', 'error'], {
          error: '只能是 info、warning 或 error',
        }).nullish(),
        title: z.string({ error: 'title 必须是字符串' }).nullish(),
        body: z.string({ error: 'body 必须是字符串' }).nullish(),
      })
      .nullish(),
    server: z
      .looseObject({
        port: intAtLeast(1).nullish(),
        bind: z.string({ error: 'bind 必须是字符串' }).nullish(),
        web_dist: z.string({ error: 'web_dist 必须是字符串' }).nullish(),
      })
      .nullish(),
    poll: z
      .looseObject({
        interval_ms: intAtLeast(500).nullish(),
        timeout_ms: intAtLeast(1000).nullish(),
        stale_after_ms: intAtLeast(1000).nullish(),
        down_after_failures: intAtLeast(1).nullish(),
      })
      .nullish(),
    ssh: z
      .looseObject({
        user: z.string({ error: 'user 必须是字符串' }).nullish(),
        control_persist_s: intAtLeast(0).nullish(),
        connect_timeout_s: intAtLeast(1).nullish(),
        extra_options: z.array(z.string(), { error: '必须是字符串数组' }).nullish(),
      })
      .nullish(),
    db: z
      .looseObject({
        path: z.string({ error: 'path 必须是字符串' }).nullish(),
        raw_retention_hours: intAtLeast(0).nullish(),
      })
      .nullish(),
    naming: z
      .looseObject({
        strip_domain: z.boolean().nullish(),
        capitalize: z.boolean().nullish(),
      })
      .nullish(),
    admin: z
      .looseObject({
        password: z.string({ error: 'password 必须是字符串' }).nullish(),
        password_sha256: z.string({ error: 'password_sha256 必须是字符串' }).nullish(),
        session_hours: intAtLeast(1).nullish(),
      })
      .nullish(),
    disk_exclude: z.array(z.string(), { error: '必须是挂载点数组' }).nullish(),
    gpu_names: z.record(z.string(), z.string(), {
      error: '必须是一个对象,把 nvidia-smi 的型号名映射到显示名',
    }).nullish(),
    hosts: z
      .array(RawHostSchema, { error: 'hosts 必须是数组' })
      .min(1, '至少要配置一台机器'),
  })
  .superRefine((config, ctx) => {
    // Duplicate ids would silently collapse two machines into one entry in the
    // state map, so the later machine would never be polled.
    const seen = new Set();
    config.hosts.forEach((host, index) => {
      if (seen.has(host.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['hosts', index, 'id'],
          message: `机器 id "${host.id}" 重复`,
        });
      }
      seen.add(host.id);
    });
  });

export type RawConfig = z.infer<typeof RawConfigSchema>;
export type RawHost = z.infer<typeof RawHostSchema>;

/**
 * Render zod issues as one readable line per problem.
 *
 * Paths are shown in the same `hosts[2].disks[0]` form a person would use when
 * looking at the file.
 */
export function formatConfigIssues(issues: z.core.$ZodIssue[]): string {
  return issues
    .map((issue) => {
      const path = issue.path.reduce<string>((acc, part) => {
        if (typeof part === 'number') return `${acc}[${part}]`;
        return acc ? `${acc}.${part}` : String(part);
      }, '');
      return `  ${path || '(根)'}: ${issue.message}`;
    })
    .join('\n');
}
