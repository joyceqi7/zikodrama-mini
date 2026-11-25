import versionConfig from '../../configs/mini-version.json';

/** miniAppVersion 返回随包固定的业务版本，缺少构建注入时读取共享配置。 */
export function miniAppVersion(): string {
  return typeof __MINI_APP_VERSION__ === 'string' ? __MINI_APP_VERSION__ : versionConfig.appVersion;
}
