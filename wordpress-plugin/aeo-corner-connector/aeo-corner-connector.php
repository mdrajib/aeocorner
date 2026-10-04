<?php
/**
 * Plugin Name:       AEO Corner Connector
 * Plugin URI:        https://aeocorner.com/wordpress
 * Description:       Lets your AEO Corner account add structured data (JSON-LD) and page titles and descriptions to your pages on the server, and tells search and AI engines about new pages (IndexNow).
 * Version:           1.1.0
 * Requires at least: 6.2
 * Requires PHP:      7.4
 * Author:            AEO Corner
 * Author URI:        https://aeocorner.com
 * License:           GPL-2.0-or-later
 * License URI:       https://www.gnu.org/licenses/gpl-2.0.html
 * Text Domain:       aeo-corner-connector
 *
 * What it does, and nothing else:
 *   - keeps one shared secret, given to it once by an administrator (an application password) when the site is
 *     connected in the AEO Corner app;
 *   - accepts a few REST requests from the AEO Corner app, each signed with that secret (HMAC-SHA256, a timestamp
 *     within five minutes and a nonce that works once), and refuses everything else;
 *   - prints the JSON-LD the app saved for a page in that page's <head> on the server, so crawlers that do not run
 *     JavaScript see it, and changes a page's title and description (through Yoast SEO or Rank Math when one is
 *     active);
 *   - adds Allow lines for answer crawlers to the end of the robots.txt WordPress builds, when the app saved some;
 *   - serves the IndexNow key file and tells IndexNow's servers about a changed page when the app asks.
 * It makes no request of its own except to IndexNow, and only for addresses on this site.
 *
 * @package AEOCornerConnector
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

define( 'AEO_CORNER_VERSION', '1.1.0' );
define( 'AEO_CORNER_NAMESPACE', 'aeocorner/v1' );
define( 'AEO_CORNER_DIR', plugin_dir_path( __FILE__ ) );

require_once AEO_CORNER_DIR . 'includes/class-aeo-signature.php';
require_once AEO_CORNER_DIR . 'includes/class-aeo-store.php';
require_once AEO_CORNER_DIR . 'includes/class-aeo-rest.php';
require_once AEO_CORNER_DIR . 'includes/class-aeo-frontend.php';
require_once AEO_CORNER_DIR . 'includes/class-aeo-admin.php';

add_action( 'rest_api_init', array( 'AEO_Rest', 'register' ) );
add_action( 'init', array( 'AEO_Frontend', 'boot' ) );
add_action( 'admin_menu', array( 'AEO_Admin', 'menu' ) );
add_action( 'admin_post_aeo_corner_disconnect', array( 'AEO_Admin', 'disconnect' ) );
