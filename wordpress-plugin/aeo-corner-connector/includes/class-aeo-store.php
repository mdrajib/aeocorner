<?php
/**
 * What the plugin keeps, in WordPress options (never autoloaded: they are read only when a page needs them).
 *
 *   aeo_corner_secret      the shared secret (set by an administrator during the handshake, erased on disconnect)
 *   aeo_corner_indexnow    the IndexNow key
 *   aeo_corner_schema      page address key => JSON-LD, as text
 *   aeo_corner_meta        page address key => title and description
 *   aeo_corner_robots      Allow lines added to the end of the robots.txt WordPress builds
 *
 * @package AEOCornerConnector
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

class AEO_Store {
	const MAX_ENTRIES  = 500;
	const MAX_JSON     = 204800; // 200 KB of JSON-LD for one page.
	const MAX_ROBOTS   = 2000;
	const OPTION_NAMES = array( 'aeo_corner_secret', 'aeo_corner_indexnow', 'aeo_corner_schema', 'aeo_corner_meta', 'aeo_corner_robots' );

	public static function secret() {
		$secret = get_option( 'aeo_corner_secret', '' );
		return is_string( $secret ) ? $secret : '';
	}

	public static function connected() {
		return '' !== self::secret();
	}

	/** An address as a key: host and path only, no scheme, query, fragment, "www." or trailing slash. */
	public static function key_for( $url ) {
		$parts = wp_parse_url( (string) $url );
		if ( empty( $parts['host'] ) ) {
			return '';
		}
		$host = strtolower( preg_replace( '/^www\./i', '', $parts['host'] ) );
		$path = isset( $parts['path'] ) ? rtrim( $parts['path'], '/' ) : '';
		return $host . $path;
	}

	/** True when the address belongs to this site. */
	public static function is_own( $url ) {
		$home = wp_parse_url( home_url() );
		$them = wp_parse_url( (string) $url );
		if ( empty( $home['host'] ) || empty( $them['host'] ) ) {
			return false;
		}
		$strip = static function ( $h ) {
			return strtolower( preg_replace( '/^www\./i', '', $h ) );
		};
		return $strip( $home['host'] ) === $strip( $them['host'] );
	}

	private static function table( $option ) {
		$value = get_option( $option, array() );
		return is_array( $value ) ? $value : array();
	}

	public static function get_schema( $url ) {
		$table = self::table( 'aeo_corner_schema' );
		$key   = self::key_for( $url );
		return isset( $table[ $key ] ) ? $table[ $key ] : null;
	}

	public static function set_schema( $url, $json ) {
		$table = self::table( 'aeo_corner_schema' );
		$key   = self::key_for( $url );
		if ( '' === $key || ( ! isset( $table[ $key ] ) && count( $table ) >= self::MAX_ENTRIES ) ) {
			return false;
		}
		$table[ $key ] = $json;
		return update_option( 'aeo_corner_schema', $table, false ) || get_option( 'aeo_corner_schema' ) === $table;
	}

	public static function remove_schema( $url ) {
		$table = self::table( 'aeo_corner_schema' );
		$key   = self::key_for( $url );
		if ( ! isset( $table[ $key ] ) ) {
			return false;
		}
		unset( $table[ $key ] );
		update_option( 'aeo_corner_schema', $table, false );
		return true;
	}

	public static function get_meta( $url ) {
		$table = self::table( 'aeo_corner_meta' );
		$key   = self::key_for( $url );
		return isset( $table[ $key ] ) ? $table[ $key ] : null;
	}

	public static function set_meta( $url, $title, $description ) {
		$table = self::table( 'aeo_corner_meta' );
		$key   = self::key_for( $url );
		if ( '' === $key || ( ! isset( $table[ $key ] ) && count( $table ) >= self::MAX_ENTRIES ) ) {
			return false;
		}
		$table[ $key ] = array(
			'title'       => (string) $title,
			'description' => (string) $description,
		);
		update_option( 'aeo_corner_meta', $table, false );
		return true;
	}

	/** Forget the title and description saved for a page, so the site's own come back. */
	public static function remove_meta( $url ) {
		$table = self::table( 'aeo_corner_meta' );
		$key   = self::key_for( $url );
		if ( ! isset( $table[ $key ] ) ) {
			return false;
		}
		unset( $table[ $key ] );
		update_option( 'aeo_corner_meta', $table, false );
		return true;
	}

	/** The Allow lines saved for robots.txt, or null. */
	public static function get_robots() {
		$lines = get_option( 'aeo_corner_robots', '' );
		return is_string( $lines ) && '' !== $lines ? $lines : null;
	}

	public static function set_robots( $lines ) {
		update_option( 'aeo_corner_robots', (string) $lines, false );
		return true;
	}

	public static function remove_robots() {
		$had = null !== self::get_robots();
		delete_option( 'aeo_corner_robots' );
		return $had;
	}

	/** Does the site have a real robots.txt file? Then WordPress never builds one, and nothing we add would be read. */
	public static function robots_file_exists() {
		return file_exists( ABSPATH . 'robots.txt' );
	}

	/** Erase everything the app gave us. */
	public static function wipe() {
		foreach ( self::OPTION_NAMES as $name ) {
			delete_option( $name );
		}
	}
}
