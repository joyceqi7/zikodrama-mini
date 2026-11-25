import { CaretLeftIcon } from "@phosphor-icons/react/dist/csr/CaretLeft";
import { Link } from "react-router-dom";
import { text as t } from "../copy";
import { useRuntime } from "../runtime/RuntimeContext";

/** AccountHeader 显示当前应用名称和返回首页入口，右侧留给 TikTok 原生胶囊。 */
export function AccountHeader() {
  const { name } = useRuntime().getApplicationBrand();
  return (
    <header className="account-header">
      <div className="account-header-row">
        <Link to="/" className="account-back" aria-label={t("common.back")}>
          <CaretLeftIcon size={23} aria-hidden="true" />
        </Link>
        <strong className="account-brand">{name}</strong>
      </div>
    </header>
  );
}
