import type { AccessOffer } from './types';

/** OfferActions 将页面的广告和 VIP 交互交给获取方式策略编排。 */
export interface OfferActions {
  /** 发起广告并使用原领取幂等键完成权益结算。 */
  rewardedAd(offer: AccessOffer): Promise<void>;
  /** 打开所选 VIP 规则的进度弹窗。 */
  vip(offer: AccessOffer): void;
}

/** OfferStrategy 表达已接通获取方式的客户端能力；支付接入时注册新实现。 */
export interface OfferStrategy {
  /** 判断当前客户端能否完整执行此入口。 */
  supports(offer: AccessOffer): boolean;
  /** 使用服务端给定入口执行获取流程，不自行构造权益。 */
  execute(offer: AccessOffer, actions: OfferActions): Promise<void>;
}

const strategies: Readonly<Record<string, OfferStrategy>> = {
  rewarded_ad: {
    supports: (offer) => Boolean(offer.offerId && offer.adUnitId) && ['rewarded_episode', 'rewarded_vip'].includes(offer.kind),
    async execute(offer, actions) {
      if (offer.kind === 'rewarded_vip') actions.vip(offer);
      else await actions.rewardedAd(offer);
    },
  },
};

/** availableOffers 保持服务端顺序并过滤未知能力，旧广告合同仅在缺少列表时适配。 */
export function availableOffers(result: { offers?: AccessOffer[]; offer: AccessOffer; vipOffer?: AccessOffer }): AccessOffer[] {
  const offers = result.offers ?? [result.offer, ...(result.vipOffer ? [result.vipOffer] : [])];
  const seen = new Set<string>();
  return offers.filter((offer) => {
    const strategy = strategies[offer.method ?? 'rewarded_ad'];
    if (!strategy?.supports(offer) || seen.has(offer.offerId)) return false;
    seen.add(offer.offerId);
    return true;
  });
}

/** executeOffer 通过类型注册表分发，未接通 IAP、订阅或未知方式均不触发广告或付款。 */
export async function executeOffer(offer: AccessOffer, actions: OfferActions): Promise<void> {
  const strategy = strategies[offer.method ?? 'rewarded_ad'];
  if (strategy?.supports(offer)) await strategy.execute(offer, actions);
}
