module.exports = (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({
    slug: process.env.MERCHANT_SLUG || '',
    store_name: process.env.MERCHANT_STORE_NAME || '',
    platform_url: process.env.PLATFORM_URL || '',
    image_cdn_base: process.env.IMAGE_CDN_BASE || '',
  });
};
