<?php
/**
 * Checks that a request really comes from the AEO Corner app.
 *
 * The app signs every request after the handshake:
 *
 *   X-AEO-Timestamp  seconds since 1970
 *   X-AEO-Nonce      16 random bytes, hex; each nonce is accepted once
 *   X-AEO-Signature  hex HMAC-SHA256 of  "AEO1\n" . timestamp . "\n" . nonce . "\n" . METHOD . "\n" . route . "\n" . sha256hex(body)
 *
 * `route` is the REST route ("/aeocorner/v1/schema"), not the whole address, so a site in a sub-folder or with plain
 * permalinks signs the same thing. This must stay in step with `canonicalRequest` and `verifySignature` in the app
 * (src/integrations/wordpress.js); the contract test runs both against each other.
 *
 * @package AEOCornerConnector
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

class AEO_Signature {
	const WINDOW_SECONDS = 300;
	const NONCE_SECONDS  = 700;

	/**
	 * @param string $secret    The shared secret.
	 * @param array  $headers   Lower-case header name => value.
	 * @param string $method    HTTP method.
	 * @param string $route     REST route.
	 * @param string $body      Raw body.
	 * @param int    $now       Current time (seconds).
	 * @return true|string      True, or the reason: missing, stale, bad_nonce, bad_signature.
	 */
	public static function check( $secret, $headers, $method, $route, $body, $now ) {
		$timestamp = isset( $headers['x-aeo-timestamp'] ) ? $headers['x-aeo-timestamp'] : '';
		$nonce     = isset( $headers['x-aeo-nonce'] ) ? $headers['x-aeo-nonce'] : '';
		$signature = isset( $headers['x-aeo-signature'] ) ? $headers['x-aeo-signature'] : '';
		if ( '' === $timestamp || '' === $nonce || '' === $signature ) {
			return 'missing';
		}
		if ( ! preg_match( '/^\d{9,11}$/', $timestamp ) || abs( $now - (int) $timestamp ) > self::WINDOW_SECONDS ) {
			return 'stale';
		}
		if ( ! preg_match( '/^[0-9a-f]{16,64}$/', $nonce ) ) {
			return 'bad_nonce';
		}
		if ( ! preg_match( '/^[0-9a-f]{64}$/', $signature ) ) {
			return 'bad_signature';
		}
		$canonical = implode( "\n", array( 'AEO1', $timestamp, $nonce, strtoupper( $method ), $route, hash( 'sha256', $body ) ) );
		$expected  = hash_hmac( 'sha256', $canonical, $secret );
		if ( ! hash_equals( $expected, $signature ) ) {
			return 'bad_signature';
		}
		return true;
	}

	/** A nonce works once: true if it was unused (and is now used up), false if it was seen before. */
	public static function use_nonce( $nonce ) {
		$key = 'aeo_nonce_' . substr( $nonce, 0, 64 );
		if ( false !== get_transient( $key ) ) {
			return false;
		}
		set_transient( $key, 1, self::NONCE_SECONDS );
		return true;
	}
}
