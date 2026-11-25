import { safeErrorMessage } from "../../observability/clientLog";

/** isAdActiveConflict 只归并官方已知的 11006 形式，不通过截取主码猜测其他错误。 */
export function isAdActiveConflict(codes: { errorCode?: string; subErrorCode?: string }): boolean {
  return codes.errorCode === "11006" || codes.errorCode === "104111006" || codes.subErrorCode === "11006";
}

/** platformErrorMessage 只提取 SDK 的错误消息字段，不序列化回调对象、扩展数据或身份凭据。 */
export function platformErrorMessage(reason: unknown, fallback: string): string {
  if (reason instanceof Error || typeof reason === "string") return safeErrorMessage(reason);
  if (reason && typeof reason === "object") {
    const value = reason as { error_msg?: unknown; errMsg?: unknown; message?: unknown; error?: unknown };
    if (typeof value.error_msg === "string") return safeErrorMessage(value.error_msg);
    if (typeof value.errMsg === "string") return safeErrorMessage(value.errMsg);
    if (typeof value.message === "string") return safeErrorMessage(value.message);
    if (value.error && value.error !== reason && typeof value.error === "object") {
      const nested = value.error as { error_msg?: unknown; errMsg?: unknown; message?: unknown };
      const message = nested.error_msg ?? nested.errMsg ?? nested.message;
      if (typeof message === "string") return safeErrorMessage(message);
    }
  }
  return fallback;
}

/** platformErrorCodes 只提取官方数值错误码，绝不序列化 SDK 扩展对象。 */
export function platformErrorCodes(reason: unknown): { errorCode?: string; subErrorCode?: string; innerErrorCode?: string } {
  if (!reason || typeof reason !== "object") return {};
  const value = reason as Record<string, unknown>;
  const code = (input: unknown): string | undefined => {
    if (typeof input !== "number" && typeof input !== "string") return;
    const text = String(input);
    return /^-?\d{1,10}$/.test(text) ? text : undefined;
  };
  const nested = value.error && typeof value.error === "object" && value.error !== reason ? value.error as Record<string, unknown> : {};
  return { errorCode: code(value.error_code ?? value.errorCode ?? nested.error_code ?? nested.errorCode),
    subErrorCode: code(value.sub_error_code ?? value.subErrorCode ?? nested.sub_error_code ?? nested.subErrorCode),
    innerErrorCode: code(value.inner_error_code ?? value.innerErrorCode ?? nested.inner_error_code ?? nested.innerErrorCode) };
}

/** isAdContainerUnavailable 仅按明确子码或内部码识别 50008，不把通用主码 101150000 全部归类。 */
export function isAdContainerUnavailable(codes: { subErrorCode?: string; innerErrorCode?: string }): boolean {
  return codes.subErrorCode === "50008" || codes.innerErrorCode === "50008";
}

/** isAdForegroundRejected 识别宿主明确要求 Mini 在前台展示广告的主码与子码组合。 */
export function isAdForegroundRejected(codes: { errorCode?: string; subErrorCode?: string }): boolean {
  return codes.errorCode === "101150000" && codes.subErrorCode === "50010";
}

/** platformInnerErrorMessage 只读取并脱敏内部错误文本，绝不上传原始 SDK 对象。 */
export function platformInnerErrorMessage(reason: unknown): string | undefined {
  if (!reason || typeof reason !== "object") return;
  const value = reason as Record<string, unknown>;
  const nested = value.error && typeof value.error === "object" ? value.error as Record<string, unknown> : {};
  const message = value.inner_error_msg ?? value.innerErrorMsg ?? nested.inner_error_msg ?? nested.innerErrorMsg;
  return typeof message === "string" ? safeErrorMessage(message) : undefined;
}
