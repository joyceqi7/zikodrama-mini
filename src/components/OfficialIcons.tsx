import type { SVGProps } from "react";

// 图形来自官方 tiktok-minis-drama-demo 的 Icons.tsx，仅保留已接通的入口。
type IconProps = SVGProps<SVGSVGElement>;
const Icon = ({ children, ...props }: IconProps) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>{children}</svg>
);

/** HomeIcon 沿用官方发现页入口图形。 */
export const HomeIcon = (props: IconProps) => <Icon {...props}><path d="m3 10 9-7 9 7v10h-6v-6H9v6H3Z" /></Icon>;
/** BookmarkIcon 表示当前访客在本机保存的剧目。 */
export const BookmarkIcon = (props: IconProps) => <Icon {...props}><path d="M6 3h12v18l-6-4-6 4Z" /></Icon>;
/** UserIcon 表示当前应用的个人入口。 */
export const UserIcon = (props: IconProps) => <Icon {...props}><circle cx="12" cy="8" r="4" /><path d="M4 21c.8-4.4 3.5-6 8-6s7.2 1.6 8 6" /></Icon>;
/** ShareIcon 引导使用已经注册资料的 TikTok 官方分享菜单。 */
export const ShareIcon = (props: IconProps) => <Icon {...props}><path d="m14 4 7 7-7 7v-4C8 14 5 16 3 20c.5-8 4-11 11-11Z" /></Icon>;
/** DramaIcon 沿用官方剧集选择栏图形。 */
export const DramaIcon = (props: IconProps) => <Icon {...props}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M7 4v16M17 4v16M3 8h4M3 12h4M3 16h4M17 8h4M17 12h4M17 16h4" /><path d="m10 9 5 3-5 3Z" fill="currentColor" stroke="none" /></Icon>;
/** ChevronUpIcon 表示打开官方选集面板。 */
export const ChevronUpIcon = (props: IconProps) => <Icon {...props}><path d="m6 15 6-6 6 6" /></Icon>;
