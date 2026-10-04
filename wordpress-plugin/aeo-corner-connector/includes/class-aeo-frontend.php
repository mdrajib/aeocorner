<?php
/**
 * What visitors and crawlers see: the saved JSON-LD in the page's <head> (printed by the server, so crawlers that do not
 * run JavaScript get it), the saved title and description, and the IndexNow key file.
 *
 * @package AEOCornerConnector
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

class AEO_Frontend {
	public static function boot() {
		add_action( 'wp_head', array( __CLASS__, 'print_head' ), 1 );
		add_filter( 'pre_get_document_title', array( __CLASS__, 'document_title' ), 20 );
		add_filter( 'wpseo_title', array( __CLASS__, 'document_title' ), 20 );
		add_filter( 'wpseo_metadesc', array( __CLASS__, 'description' ), 20 );
		add_filter( 'rank_math/frontend/title', array( __CLASS__, 'document_title' ), 20 );
		add_filter( 'rank_math/frontend/description', array( __CLASS__, 'description' ), 20 );
		add_action( 'template_redirect', array( __CLASS__, 'serve_indexnow_key' ), 0 );
	}

	/** The address of the page being shown. */
	private static function current_url() {
		if ( is_singular() ) {
			$link = get_permalink();
			if ( $link ) {
				return $link;
			}
		}
		$request = isset( $_SERVER['REQUEST_URI'] ) ? wp_unslash( $_SERVER['REQUEST_URI'] ) : '/'; // phpcs:ignore WordPress.Security.ValidatedSanitizedInput.InputNotSanitized
		$path    = wp_parse_url( $request, PHP_URL_PATH );
		return home_url( is_string( $path ) ? $path : '/' );
	}

	private static function other_seo_plugin_prints_description() {
		return defined( 'WPSEO_VERSION' ) || class_exists( 'RankMath' ) || defined( 'RANK_MATH_VERSION' );
	}

	public static function print_head() {
		if ( is_admin() || is_feed() || is_robots() || is_trackback() || ! AEO_Store::connected() ) {
			return;
		}
		$url    = self::current_url();
		$schema = AEO_Store::get_schema( $url );
		if ( is_string( $schema ) && '' !== $schema ) {
			// The JSON was encoded with < > & written as escapes when it was saved, so it cannot end this block.
			echo '<script type="application/ld+json">' . $schema . "</script>\n"; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped
		}
		$meta = AEO_Store::get_meta( $url );
		if ( is_array( $meta ) && ! empty( $meta['description'] ) && ! self::other_seo_plugin_prints_description() ) {
			echo '<meta name="description" content="' . esc_attr( $meta['description'] ) . "\">\n";
		}
	}

	public static function document_title( $title ) {
		if ( is_admin() || ! AEO_Store::connected() ) {
			return $title;
		}
		$meta = AEO_Store::get_meta( self::current_url() );
		return is_array( $meta ) && ! empty( $meta['title'] ) ? $meta['title'] : $title;
	}

	public static function description( $description ) {
		if ( is_admin() || ! AEO_Store::connected() ) {
			return $description;
		}
		$meta = AEO_Store::get_meta( self::current_url() );
		return is_array( $meta ) && ! empty( $meta['description'] ) ? $meta['description'] : $description;
	}

	/** `/<key>.txt` answers with the key, so IndexNow can check that the site is ours. */
	public static function serve_indexnow_key() {
		$key = (string) get_option( 'aeo_corner_indexnow', '' );
		if ( '' === $key ) {
			return;
		}
		$request = isset( $_SERVER['REQUEST_URI'] ) ? wp_unslash( $_SERVER['REQUEST_URI'] ) : ''; // phpcs:ignore WordPress.Security.ValidatedSanitizedInput.InputNotSanitized
		$path    = wp_parse_url( $request, PHP_URL_PATH );
		if ( ! is_string( $path ) || basename( $path ) !== $key . '.txt' ) {
			return;
		}
		status_header( 200 );
		header( 'Content-Type: text/plain; charset=utf-8' );
		echo esc_html( $key );
		exit;
	}
}
