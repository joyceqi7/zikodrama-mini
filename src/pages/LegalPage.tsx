import { ArrowLeft } from "lucide-react";
import { useNavigate } from "react-router-dom";

import { currentApplicationProfile } from "../config/applicationProfile";
import { governingLaw, legalEntity, supportEmail as email } from "../config/brand";

function Contact() {
  return <a href={`mailto:${email}`}>{email}</a>;
}

/** 隐私政策在标题下单列认证主体，避免将应用品牌误认为法律实体。 */
function LegalShell({ children, title, showLegalEntity = false }: { children: React.ReactNode; title: string; showLegalEntity?: boolean }) {
  const navigate = useNavigate();
  return (
    <main className="legal-page">
      <header className="legal-header">
        <button type="button" aria-label="Go back" onClick={() => navigate(-1)}>
          <ArrowLeft aria-hidden="true" />
        </button>
        <div>
          <h1>{title}</h1>
          {showLegalEntity ? <p>Legal entity: <strong>{legalEntity}</strong></p> : null}
          <p>Effective Date: February 13, 2026&nbsp; | &nbsp;Last Update: February 13, 2026</p>
        </div>
      </header>
      <article className="legal-document">{children}</article>
      <footer>Copyright © 2026 {legalEntity} · All rights reserved.</footer>
    </main>
  );
}

/** 展示当前应用的内置隐私政策，并标明与企业认证一致的主体名称。 */
export function PrivacyPolicyPage() {
  const appName = currentApplicationProfile().name;
  return (
    <LegalShell title={`${appName} Privacy Policy`} showLegalEntity>
      <h2>Introduction</h2>
      <p>Welcome to the <strong>{appName}</strong> short drama application (“{appName}” or the “Service”). This Privacy Policy is established by <strong>{legalEntity}</strong> (“we” or the “Company”) to help you understand how we collect, use, store, and protect your personal information.</p>
      <p>By using the Service, you confirm that you have read and understood this Policy and the processing of your personal information described here. Questions may be sent to <Contact />.</p>

      <nav className="legal-toc" aria-label="Table of contents">
        <strong>Table of Contents</strong>
        <ol>
          <li>Information We Collect</li><li>How We Use Information</li>
          <li>Sharing and Disclosure of Information</li><li>Storage and Protection of Information</li>
          <li>Your Rights and Choices</li><li>Processing of Minors’ Information</li>
          <li>International Data Transfers</li><li>Retention</li><li>Data Deletion</li>
          <li>Updates to the Privacy Policy</li><li>Contact Us</li>
        </ol>
      </nav>

      <h2>1. Information We Collect</h2>
      <p>We may collect information you provide, information collected automatically, and information obtained from third parties.</p>
      <h3>1.1 Information You Provide</h3>
      <p>This may include account and profile information, payment and transaction details, feedback, support requests, and contact details such as account name, mobile number, or email address.</p>
      <h3>1.2 Information Collected Automatically</h3>
      <p>This may include device information, usage data, location information, cookies, and similar technologies.</p>
      <h3>1.3 Information Obtained from Third Parties</h3>
      <p>We may receive information from social media services, advertising partners, single sign-on platforms, related entities, business partners, other customers, or your authorized representatives.</p>
      <h3>1.4 User-Generated Content</h3>
      <p>Where the Service lets you create, upload, publish, store, or share text, images, videos, comments, or bullet comments, we process that content and associated metadata to provide the relevant interactive features. Public content may be visible to unspecified users, so do not disclose sensitive personal information in it.</p>
      <p>You are responsible for ensuring that content you publish is lawful, appropriately authorized, and does not infringe the rights of others. We may review, remove, restrict, or report content that violates law, this Policy, or the applicable user agreement. Deleted content may remain in copies, caches, or material already shared by others.</p>

      <h2>2. How We Use Information</h2>
      <h3>2.1 Providing Services</h3>
      <p>We use information to create and maintain accounts, provide browsing, search, video-on-demand, social and support features, process orders through relevant payment providers, maintain security, and operate the Service.</p>
      <p>Usage logs may include account, search, network, language, access time, page-view, refresh, follow, subscription, favorite, and sharing activity. Device data may include device and operating-system type, app version, resolution, package and device settings, advertising identifiers, and IP address.</p>
      <h3>2.2 Improving Services</h3>
      <p>We may use information to develop and improve the Service, personalize content and recommendations, respond to requests, diagnose faults, measure service health, and deliver technical, security, support, and administrative notices.</p>
      <h3>2.3 Marketing and Advertising</h3>
      <p>You may opt out of marketing through the unsubscribe mechanism in the communication or by contacting <Contact />. Service-related messages may still be sent when necessary. Device or service settings may provide additional controls for advertising and tracking technologies.</p>
      <h3>2.4 Security and Compliance</h3>
      <p>We use information to protect the Service, prevent fraud, hacking, cheating, spam, and other unlawful or unauthorized activity, investigate incidents, and enforce our terms. Security tools may process operating-system, CPU architecture, application package, and signature information locally to support hardening and anti-tampering measures.</p>
      <h3>2.5 Notifications and Permissions</h3>
      <p>With your consent and subject to device settings, we may send push notifications. Specific features may request storage or device permissions. You can manage these permissions through your device settings.</p>

      <h2>3. Sharing and Disclosure of Information</h2>
      <p>We do not share personal information outside {appName} without consent except when needed to provide or improve the Service, work with contracted providers, comply with law, protect rights and safety, resolve disputes, complete a corporate transaction, or respond to a lawful request.</p>
      <p>Recipients are required to process information for lawful, necessary, specific purposes and apply suitable confidentiality and security measures. De-identified information that cannot reasonably identify a person may be processed and shared as permitted by law.</p>

      <h2>4. Storage and Protection of Information</h2>
      <p>Information may be stored in the United States or other countries where we, our affiliates, partners, or service providers operate. We use reasonable technical, organizational, access-control, monitoring, and incident-response measures. No Internet transmission or storage system can be guaranteed to be completely secure.</p>

      <h2>5. Your Rights and Choices</h2>
      <p>Depending on your location and applicable law, you may request access to, correction or deletion of, or a portable copy of your information. We may need to verify your identity and may decline a request where a legal exception applies. {appName} does not currently sell personal information for monetary consideration.</p>

      <h2>6. Processing of Minors’ Information</h2>
      <p>{appName} is not intended for children under 13. We do not knowingly collect their personal information without legally required consent. If you believe a child’s information has been collected, contact <Contact /> so it can be removed as required by law. Users under 18 should use the Service with a parent or legal guardian’s consent.</p>

      <h2>7. International Data Transfers</h2>
      <p>Your information may be transferred internationally in accordance with applicable law. We take appropriate steps to protect it, although the law in the destination may provide a different level of protection from your country of residence.</p>

      <h2>8. Retention</h2>
      <p>We retain personal information only as long as needed for the purposes in this Policy or as required or permitted by law, taking account of its amount, nature, sensitivity, risks, and the purposes of processing.</p>

      <h2>9. Data Deletion</h2>
      <p>You may request deletion of your personal information and associated account data by emailing <Contact />. We will process the request within a reasonable period and in accordance with applicable law.</p>

      <h2>10. Updates to the Privacy Policy</h2>
      <p>We may update this Privacy Policy. The latest version will be posted with its effective date, and we recommend reviewing it periodically.</p>

      <h2>11. Contact Us</h2>
      <ul><li>Email: <Contact /></li><li>Company: <strong>{legalEntity}</strong></li></ul>
    </LegalShell>
  );
}

/** 展示当前应用的内置服务条款，并使用相同的认证主体名称。 */
export function AgreementPage() {
  const appName = currentApplicationProfile().name;
  return (
    <LegalShell title={`${appName} Terms of Services`}>
      <h2>1. Introduction</h2>
      <p>Welcome to <strong>{appName}</strong>, a short drama application and website operated by <strong>{legalEntity}</strong>. By using the Service, you agree to these Terms of Services. If you do not agree, please do not use the Service.</p>

      <h2>2. Eligibility</h2>
      <p>You must be at least 13 years old to use the Service. If you are under 18, you must have consent from a parent or legal guardian.</p>

      <h2>3. User Accounts</h2>
      <p>Some features may require an account. Information you submit must be accurate and kept current. You are responsible for keeping your credentials secure, restricting access to your account, and all purchases and other activity under it.</p>
      <p>You may delete your account, after which you may lose access to all or part of the Service. We may disable, suspend, or terminate an account, particularly when these Terms are violated.</p>

      <h2>4. Content and Usage Rules</h2>
      <p>You agree not to:</p>
      <ul>
        <li>Use the Service unlawfully or violate applicable laws or regulations.</li>
        <li>Post illegal, abusive, threatening, defamatory, obscene, hateful, discriminatory, infringing, or otherwise harmful content.</li>
        <li>Post content that exploits or endangers minors.</li>
        <li>Hack, scrape, reverse engineer, disrupt, or gain unauthorized access to the Service.</li>
        <li>Use the Service in a way that harms its operation or another user’s experience.</li>
      </ul>

      <h2>5. Intellectual Property</h2>
      <p>The Service and its text, graphics, software, trademarks, source code, interfaces, web pages, images, audio, video, and other content are owned by or licensed to {legalEntity} or other rights holders and protected by intellectual-property law. No rights are granted except as expressly stated in these Terms.</p>
      <p>You must own or have permission to publish content you upload. You grant us a worldwide, perpetual, non-exclusive, irrevocable, royalty-free, sublicensable right to use, modify, reproduce, distribute, publish, perform, transmit, advertise, and otherwise use that content in connection with the Service and its promotion, to the extent permitted by law.</p>
      <p>Copyright complaints, including qualifying DMCA notices, may be sent to <Contact /> with identification of the protected work, the disputed material and its location, your contact details, required good-faith and accuracy statements, and an authorized signature.</p>

      <h2>6. Subscription and Payments</h2>
      <h3>6.1 Subscription</h3>
      <p>Some features may require a paid subscription processed by Google Play or another payment provider. Subscription terms, pricing, billing frequency, and cancellation methods will be disclosed as required by law. Cancellation normally takes effect at the end of the current billing period.</p>
      <p>Payments are final and non-refundable except where required by law or stated in these Terms. Third-party payment services may apply their own terms, taxes, fees, foreign-exchange charges, and regional pricing. Suspected billing errors should be reported to <Contact /> within 30 days.</p>
      <h3>6.2 Virtual Currency and Goods</h3>
      <p>The Service may provide virtual currency or virtual goods. They are licensed for personal use only, have no cash value, are not real currency or stored value, and may not be sold, redeemed, transferred, wagered, or used outside the Service except where expressly authorized.</p>
      <p>We may regulate, modify, or discontinue virtual currency or goods. They may be forfeited when your account, these Terms, or the relevant Service ends, subject to applicable law.</p>

      <h2>7. Termination</h2>
      <p>We may suspend or terminate access to the Service if you violate these Terms.</p>

      <h2>8. Disclaimers and Limitation of Liability</h2>
      <p className="legal-emphasis">The Service is provided “as is” and “as available,” without warranties of any kind to the maximum extent permitted by law. To that extent, {appName} is not liable for indirect, incidental, special, consequential, or punitive damages, or loss of data, use, or goodwill arising from the Service.</p>

      <h2>9. Governing Law</h2>
      <p>These Terms are governed by the laws of {governingLaw}.</p>

      <h2>10. Contact Us</h2>
      <ul><li>Email: <Contact /></li><li>Company: <strong>{legalEntity}</strong></li></ul>
    </LegalShell>
  );
}
