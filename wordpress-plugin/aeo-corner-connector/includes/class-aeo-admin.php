<?php
/**
 * A small settings page (Settings → AEO Corner): is the site connected, and a one-click disconnect.
 *
 * @package AEOCornerConnector
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

class AEO_Admin {
	public static function menu() {
		add_options_page( 'AEO Corner', 'AEO Corner', 'manage_options', 'aeo-corner-connector', array( __CLASS__, 'page' ) );
	}

	public static function page() {
		if ( ! current_user_can( 'manage_options' ) ) {
			return;
		}
		$connected = AEO_Store::connected();
		echo '<div class="wrap"><h1>AEO Corner</h1>';
		if ( isset( $_GET['aeo_disconnected'] ) ) { // phpcs:ignore WordPress.Security.NonceVerification.Recommended
			echo '<div class="notice notice-success"><p>Disconnected. Everything AEO Corner saved on this site has been removed.</p></div>';
		}
		if ( $connected ) {
			echo '<p>This site is connected to your AEO Corner account. AEO Corner can add structured data and page titles on the server, and tell IndexNow about new pages.</p>';
			echo '<form method="post" action="' . esc_url( admin_url( 'admin-post.php' ) ) . '">';
			echo '<input type="hidden" name="action" value="aeo_corner_disconnect">';
			wp_nonce_field( 'aeo_corner_disconnect' );
			submit_button( 'Disconnect this site', 'secondary' );
			echo '</form>';
		} else {
			echo '<p>This site is not connected. In AEO Corner, open your project and choose WordPress to connect it.</p>';
		}
		echo '<p>Version ' . esc_html( AEO_CORNER_VERSION ) . '.</p></div>';
	}

	public static function disconnect() {
		if ( ! current_user_can( 'manage_options' ) ) {
			wp_die( 'You are not allowed to do that.', 403 );
		}
		check_admin_referer( 'aeo_corner_disconnect' );
		AEO_Store::wipe();
		wp_safe_redirect( add_query_arg( array( 'page' => 'aeo-corner-connector', 'aeo_disconnected' => '1' ), admin_url( 'options-general.php' ) ) );
		exit;
	}
}
