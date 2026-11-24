/* Certificate dates for every TLS client in the image: fos_tls_dates.h has
 * the rule, this is where mbedTLS is told it.
 *
 * Every client here (the plane link, the cloud socket, OTA, voice, a scene's
 * own requests through the runtime) trusts the certificate bundle, attached
 * with esp_crt_bundle_attach. The linker sends that name here
 * (--wrap=esp_crt_bundle_attach, main/CMakeLists.txt), so no client can be
 * written that skips the rule: the bundle is attached as before, and its
 * verify callback is called with the date flags already made to count. */
#include <stdint.h>
#include <time.h>

#include "esp_app_desc.h"
#include "esp_err.h"
#include "mbedtls/ssl.h"
#include "mbedtls/x509_crt.h"

#include "fos_tls_dates.h"

esp_err_t __real_esp_crt_bundle_attach(void *conf);
/* The bundle's own callback (esp_crt_bundle.c): not in its header, and the
 * build stops here if IDF ever hides it. */
int esp_crt_verify_callback(void *buf, mbedtls_x509_crt *const crt, const int depth, uint32_t *const flags);

static int verify(void *ctx, mbedtls_x509_crt *crt, int depth, uint32_t *flags)
{
    time_t now = time(NULL);
    struct tm utc;
    gmtime_r(&now, &utc);
    *flags = fos_tls_date_flags(*flags, (utc.tm_year + 1900) * 12 + utc.tm_mon,
                                fos_tls_release_month(esp_app_get_description()->version),
                                crt->valid_to.year * 12 + crt->valid_to.mon - 1,
                                MBEDTLS_X509_BADCERT_EXPIRED, MBEDTLS_X509_BADCERT_FUTURE);
    return esp_crt_verify_callback(ctx, crt, depth, flags);
}

esp_err_t __wrap_esp_crt_bundle_attach(void *conf)
{
    esp_err_t err = __real_esp_crt_bundle_attach(conf);
    if (err == ESP_OK && conf != NULL) mbedtls_ssl_conf_verify((mbedtls_ssl_config *)conf, verify, NULL);
    return err;
}
