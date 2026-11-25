import { FilmReelIcon } from "@phosphor-icons/react/dist/csr/FilmReel";
import { StarIcon } from "@phosphor-icons/react/dist/csr/Star";
import { UserIcon } from "@phosphor-icons/react/dist/csr/User";
import { text as t } from "../copy";
import { NavLink } from "react-router-dom";

const items = [
  { to: "/", labelKey: "nav.home", icon: FilmReelIcon },
  { to: "/library", labelKey: "nav.library", icon: StarIcon },
  { to: "/profile", labelKey: "nav.profile", icon: UserIcon },
];

/** BottomNav 统一首页、历史与个人入口，选中项使用实心图标；未登录时保留导航意图。 */
export function BottomNav({ onNavigate }: {
  /** onNavigate 暂存未登录的页面意图；缺省时直接切换已认证路由。 */
  onNavigate?: (path: string) => void;
} = {}) {
  return (
    <nav className="bottom-nav account-bottom-nav" aria-label={t("nav.primary")}>
      {items.map(({ to, labelKey, icon: Icon }) => (
        onNavigate ? <button key={to} type="button" className={to === "/" ? "nav-item is-active" : "nav-item"}
          aria-current={to === "/" ? "page" : undefined} onClick={() => onNavigate(to)}>
          <Icon weight={to === "/" ? "fill" : "regular"} aria-hidden="true" /><span>{t(labelKey)}</span>
        </button> : <NavLink key={to} to={to} end={to === "/"} className={({ isActive }) => isActive ? "nav-item is-active" : "nav-item"}>
          {({ isActive }) => <><Icon weight={isActive ? "fill" : "regular"} aria-hidden="true" /><span>{t(labelKey)}</span></>}
        </NavLink>
      ))}
    </nav>
  );
}
