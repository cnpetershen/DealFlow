import { describe, expect, it } from 'vitest';

import { ConfigEnvError, loadConfig, loadConfigFromEnv, parseConfig, policyContextFromConfig } from './config';

describe('DealFlowConfig', () => {
  it('零配置时使用确定性默认值', () => {
    const config = loadConfig();

    expect(config).toMatchObject({
      workflow_type: 'lead_follow_up',
      webhook: { path: '/webhooks/dealflow', max_body_bytes: 1_000_000, bearer_token: null },
      observability: { enabled: true },
      policy: { policy_version: 'policy_v1' },
    });
    expect(config.policy.automation_whitelist).toEqual(['send_email', 'create_task']);
    // 默认不信任代理头（可被伪造绕过限流），控制面有自己独立的限流额度
    expect(config.webhook.trust_proxy_headers).toBe(false);
    expect(config.control_plane.rate_limit_per_minute).toBe(120);
  });

  it('覆盖项生效', () => {
    const config = parseConfig({
      workflow_type: 'renewal',
      webhook: { path: '/hooks', bearer_token: 'secret-token' },
      observability: { enabled: false },
    });

    expect(config.workflow_type).toBe('renewal');
    expect(config.webhook.path).toBe('/hooks');
    expect(config.webhook.bearer_token).toBe('secret-token');
    expect(config.observability.enabled).toBe(false);
    // 未覆盖的字段回退默认值
    expect(config.webhook.max_body_bytes).toBe(1_000_000);
  });

  it('非法输入抛 ZodError', () => {
    expect(() => parseConfig({ workflow_type: '' })).toThrow();
    expect(() => parseConfig({ webhook: { max_body_bytes: -1 } })).toThrow();
    expect(() => parseConfig({ policy: { send_window: { start_hour: 25, end_hour: 9 } } })).toThrow();
  });

  it('policyContextFromConfig 从静态配置 + 运行时事实拼装 PolicyContext', () => {
    const config = loadConfig({ policy: { high_value_deal_threshold: 800000 } });

    const ctx = policyContextFromConfig(config, {
      evaluated_at: '2026-09-24T10:00:00+08:00',
      auto_actions_today: 3,
      permitted_actor_ids: ['user_7'],
    });

    expect(ctx).toMatchObject({
      policy_version: 'policy_v1',
      evaluated_at: '2026-09-24T10:00:00+08:00',
      auto_actions_today: 3,
      permitted_actor_ids: ['user_7'],
      high_value_deal_threshold: 800000,
      send_window: { start_hour: 9, end_hour: 18 },
    });
  });

  it('未识别的配置键被拒绝，避免拼错键名后静默回退默认值', () => {
    expect(() => loadConfig({ webhook: { bearerTokens: 'oops' } })).toThrow(/Unrecognized key/);
    expect(() => loadConfig({ webhook: { rate_limit_per_minutes: 5 } })).toThrow(/Unrecognized key/);
    expect(() => loadConfig({ policy: { send_window: { start_hour: 9, end_hour: 18, noon: 12 } } })).toThrow(
      /Unrecognized key/,
    );
  });
});

describe('loadConfigFromEnv', () => {
  it('空字符串等同于未设置：回退默认值而不是崩溃', () => {
    const config = loadConfigFromEnv({
      DEALFLOW_WEBHOOK_TOKEN: '',
      DEALFLOW_WEBHOOK_HMAC_SECRET: '',
      DEALFLOW_CONTROL_PLANE_TOKEN: '',
      DEALFLOW_PROVIDER_BASE_URL: '',
      DEALFLOW_PROVIDER_TOKEN: '',
      DEALFLOW_DB_TIMEOUT_MS: '',
      DEALFLOW_WEBHOOK_RATE_LIMIT_PER_MINUTE: '',
    });

    expect(config.webhook.bearer_token).toBeNull();
    expect(config.webhook.hmac_secret).toBeNull();
    expect(config.control_plane.bearer_token).toBeNull();
    expect(config.provider.base_url).toBeNull();
    expect(config.database.timeout_ms).toBe(5_000);
    expect(config.webhook.rate_limit_per_minute).toBe(600);
    expect(config.server.port).toBe(3000);
  });

  it('DEALFLOW_PORT 留空回退 3000，而不是静默变成随机端口', () => {
    expect(loadConfigFromEnv({ DEALFLOW_PORT: '' }).server.port).toBe(3000);
    expect(loadConfigFromEnv({ DEALFLOW_PORT: '8080' }).server.port).toBe(8080);
    expect(loadConfigFromEnv({ DEALFLOW_PORT: '0' }).server.port).toBe(0);
    expect(() => loadConfigFromEnv({ DEALFLOW_PORT: 'abc' })).toThrow(ConfigEnvError);
  });

  it('布尔环境变量接受常见字面量，非法值报错而不是当作 true', () => {
    for (const value of ['0', 'false', 'FALSE', 'no', 'off', 'N']) {
      expect(loadConfigFromEnv({ DEALFLOW_RETRY_ENABLED: value }).retry_scheduler.enabled).toBe(false);
    }
    for (const value of ['1', 'true', 'YES', 'on']) {
      expect(loadConfigFromEnv({ DEALFLOW_RETRY_ENABLED: value }).retry_scheduler.enabled).toBe(true);
    }
    expect(loadConfigFromEnv({ DEALFLOW_RETRY_ENABLED: '' }).retry_scheduler.enabled).toBe(true);
    expect(() => loadConfigFromEnv({ DEALFLOW_RETRY_ENABLED: 'maybe' })).toThrow(ConfigEnvError);
    expect(() => loadConfigFromEnv({ DEALFLOW_RETRY_ENABLED: 'maybe' })).toThrow(/DEALFLOW_RETRY_ENABLED/);
  });

  it('限流上限 0 表示不限流，非法数值点名环境变量', () => {
    expect(loadConfigFromEnv({ DEALFLOW_WEBHOOK_RATE_LIMIT_PER_MINUTE: '0' }).webhook.rate_limit_per_minute).toBeNull();
    expect(() => loadConfigFromEnv({ DEALFLOW_WEBHOOK_RATE_LIMIT_PER_MINUTE: '-5' })).toThrow(ConfigEnvError);
    expect(() => loadConfigFromEnv({ DEALFLOW_DB_TIMEOUT_MS: 'soon' })).toThrow(/DEALFLOW_DB_TIMEOUT_MS/);
  });

  it('控制面限流与代理头信任开关各自独立映射', () => {
    expect(loadConfigFromEnv({}).control_plane.rate_limit_per_minute).toBe(120);
    expect(loadConfigFromEnv({ DEALFLOW_CONTROL_PLANE_RATE_LIMIT_PER_MINUTE: '0' }).control_plane.rate_limit_per_minute)
      .toBeNull();
    expect(() => loadConfigFromEnv({ DEALFLOW_CONTROL_PLANE_RATE_LIMIT_PER_MINUTE: 'many' }))
      .toThrow(/DEALFLOW_CONTROL_PLANE_RATE_LIMIT_PER_MINUTE/);
    expect(() => loadConfigFromEnv({ DEALFLOW_CONTROL_PLANE_RATE_LIMIT_PER_MINUTE: '-1' }))
      .toThrow(ConfigEnvError);

    expect(loadConfigFromEnv({}).webhook.trust_proxy_headers).toBe(false);
    expect(loadConfigFromEnv({ DEALFLOW_WEBHOOK_TRUST_PROXY_HEADERS: 'true' }).webhook.trust_proxy_headers).toBe(true);
    expect(loadConfigFromEnv({ DEALFLOW_WEBHOOK_TRUST_PROXY_HEADERS: '0' }).webhook.trust_proxy_headers).toBe(false);
    expect(() => loadConfigFromEnv({ DEALFLOW_WEBHOOK_TRUST_PROXY_HEADERS: 'sure' }))
      .toThrow(/DEALFLOW_WEBHOOK_TRUST_PROXY_HEADERS/);
  });

  it('合法的一组部署参数按原样映射', () => {
    const config = loadConfigFromEnv({
      DEALFLOW_HOST: '0.0.0.0',
      DEALFLOW_PORT: '9000',
      DEALFLOW_LOG_LEVEL: 'warn',
      DEALFLOW_MAX_CONNECTIONS: '64',
      DEALFLOW_WEBHOOK_TOKEN: ' shared-token ',
      DEALFLOW_CONTROL_PLANE_ENABLED: 'false',
      DEALFLOW_PROVIDER_KIND: 'http',
      DEALFLOW_PROVIDER_BASE_URL: 'https://provider.example.com',
    });

    expect(config.server).toMatchObject({ host: '0.0.0.0', port: 9000, max_connections: 64 });
    expect(config.observability.log_level).toBe('warn');
    expect(config.webhook.bearer_token).toBe('shared-token');
    expect(config.control_plane.enabled).toBe(false);
    expect(config.provider).toMatchObject({ kind: 'http', base_url: 'https://provider.example.com' });
  });
});
