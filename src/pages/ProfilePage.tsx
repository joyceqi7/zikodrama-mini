import { CaretRightIcon } from "@phosphor-icons/react/dist/csr/CaretRight";
import { FileTextIcon } from "@phosphor-icons/react/dist/csr/FileText";
import { ShieldPlusIcon } from "@phosphor-icons/react/dist/csr/ShieldPlus";
import { UserIcon } from "@phosphor-icons/react/dist/csr/User";
import { Link } from "react-router-dom";

import { AccountHeader } from "../components/AccountHeader";
import { BottomNav } from "../components/BottomNav";
import { text as t } from "../copy";
import { useRuntime } from "../runtime/RuntimeContext";

/** ProfilePage 只展示已安装的业务观众标识及协议入口，不读取或显示 Token、OpenID。 */
export function ProfilePage() {
  const visitorId = useRuntime().getVisitorID();
  return (
    <main className="account-page profile-page">
      <AccountHeader />
      <h1 className="sr-only">{t("profile.title")}</h1>
      <section className="profile-identity" aria-label={t("profile.title")}>
        <span className="profile-avatar" aria-hidden="true"><UserIcon weight="fill" /></span>
        <div>
          <strong>{t("profile.user")}</strong>
          {visitorId && <span className="profile-user-id">{t("profile.userId", { id: visitorId })}</span>}
        </div>
      </section>
      <nav className="profile-legal-links" aria-label={t("profile.legal")}>
        <Link to="/agreement">
          <FileTextIcon aria-hidden="true" />
          <span>{t("profile.terms")}</span>
          <CaretRightIcon className="profile-link-arrow" aria-hidden="true" />
        </Link>
        <Link to="/privacy">
          <ShieldPlusIcon aria-hidden="true" />
          <span>{t("profile.privacy")}</span>
          <CaretRightIcon className="profile-link-arrow" aria-hidden="true" />
        </Link>
      </nav>
      <BottomNav />
    </main>
  );
}
