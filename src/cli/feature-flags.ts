declare const __PREVIEW__: boolean;

export const isPreviewEnabled = (): boolean => __PREVIEW__;

export const isGatedFeaturesEnabled = (): boolean => process.env.ENABLE_GATED_FEATURES === '1';
