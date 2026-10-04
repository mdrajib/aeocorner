<?php
/**
 * The plugin's REST routes (`/wp-json/aeocorner/v1/...`).
 *
 *   POST   /connect     the handshake: an administrator (application password) hands over the signing secret
 *   GET    /status      version information
 *   PUT    /schema      save JSON-LD for one page of this site
 *   DELETE /schema      remove it
 *   PUT    /meta        save a title and description for one page
 *   POST   /resolve     which post is at an address
 *   POST   /indexnow    tell IndexNow about changed addresses
 *   POST   /disconnect  forget the secret and everything saved
 *
 * Everything but /connect needs a valid signature (AEO_Signature); /connect needs `manage_options`.
 *
 * @package AEOCornerConnector
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

class AEO_Rest {
	public static function register() {
		$signed = array( __CLASS__, 'require_signature' );
		register_rest_route(
			AEO_CORNER_NAMESPACE,
			'/connect',
			array(
				'methods'             => 'POST',
				'callback'            => array( __CLASS__, 'connect' ),
				'permission_callback' => static function () {
					return current_user_can( 'manage_options' );
				},
			)
		);
		$routes = array(
			array( '/status', 'GET', 'status' ),
			array( '/schema', 'PUT', 'put_schema' ),
			array( '/schema', 'DELETE', 'delete_schema' ),
			array( '/meta', 'PUT', 'put_meta' ),
			array( '/resolve', 'POST', 'resolve' ),
			array( '/indexnow', 'POST', 'indexnow' ),
			array( '/disconnect', 'POST', 'disconnect' ),
		);
		foreach ( $routes as $route ) {
			register_rest_route(
				AEO_CORNER_NAMESPACE,
				$route[0],
				array(
					'methods'             => $route[1],
					'callback'            => array( __CLASS__, $route[2] ),
					'permission_callback' => $signed,
				)
			);
		}
	}

	/** The permission callback of every signed route. */
	public static function require_signature( $request ) {
		$secret = AEO_Store::secret();
		if ( '' === $secret ) {
			return new WP_Error( 'aeo_not_connected', 'This site is not connected to AEO Corner.', array( 'status' => 401 ) );
		}
		$headers = array();
		foreach ( array( 'x-aeo-timestamp', 'x-aeo-nonce', 'x-aeo-signature' ) as $name ) {
			$value = $request->get_header( $name );
			if ( is_string( $value ) ) {
				$headers[ $name ] = $value;
			}
		}
		$verdict = AEO_Signature::check( $secret, $headers, $request->get_method(), $request->get_route(), (string) $request->get_body(), time() );
		if ( true !== $verdict ) {
			return new WP_Error( 'aeo_bad_signature', 'The request was not signed correctly.', array( 'status' => 401, 'reason' => $verdict ) );
		}
		if ( ! AEO_Signature::use_nonce( $headers['x-aeo-nonce'] ) ) {
			return new WP_Error( 'aeo_bad_signature', 'The request was already used.', array( 'status' => 401, 'reason' => 'replayed' ) );
		}
		return true;
	}

	private static function status_data() {
		$seo = null;
		if ( defined( 'WPSEO_VERSION' ) ) {
			$seo = 'yoast';
		} elseif ( class_exists( 'RankMath' ) || defined( 'RANK_MATH_VERSION' ) ) {
			$seo = 'rankmath';
		}
		return array(
			'version'    => AEO_CORNER_VERSION,
			'wp'         => get_bloginfo( 'version' ),
			'php'        => PHP_VERSION,
			'seo_plugin' => $seo,
			'indexnow'   => '' !== (string) get_option( 'aeo_corner_indexnow', '' ),
		);
	}

	public static function connect( $request ) {
		$params = $request->get_json_params();
		$secret = is_array( $params ) && isset( $params['secret'] ) ? $params['secret'] : '';
		if ( ! is_string( $secret ) || strlen( $secret ) < 32 || strlen( $secret ) > 256 ) {
			return new WP_Error( 'aeo_bad_secret', 'The secret must be 32 to 256 characters.', array( 'status' => 400 ) );
		}
		update_option( 'aeo_corner_secret', $secret, false );
		if ( isset( $params['indexnow_key'] ) && is_string( $params['indexnow_key'] ) && preg_match( '/^[a-f0-9]{32}$/', $params['indexnow_key'] ) ) {
			update_option( 'aeo_corner_indexnow', $params['indexnow_key'], false );
		}
		return rest_ensure_response( self::status_data() );
	}

	public static function status() {
		return rest_ensure_response( self::status_data() );
	}

	private static function url_param( $request ) {
		$params = $request->get_json_params();
		$url    = is_array( $params ) && isset( $params['url'] ) && is_string( $params['url'] ) ? $params['url'] : '';
		if ( '' === $url || ! preg_match( '#^https?://#i', $url ) || ! AEO_Store::is_own( $url ) ) {
			return new WP_Error( 'aeo_wrong_site', 'That address is not a page of this site.', array( 'status' => 400 ) );
		}
		return $url;
	}

	public static function put_schema( $request ) {
		$url = self::url_param( $request );
		if ( is_wp_error( $url ) ) {
			return $url;
		}
		$params = $request->get_json_params();
		$jsonld = isset( $params['jsonld'] ) ? $params['jsonld'] : null;
		if ( ! is_array( $jsonld ) || empty( $jsonld ) ) {
			return new WP_Error( 'aeo_bad_jsonld', 'The structured data must be an object.', array( 'status' => 400 ) );
		}
		// Encoded once here, with the characters that could end a <script> block written as escapes.
		$json = wp_json_encode( $jsonld, JSON_HEX_TAG | JSON_HEX_AMP | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE );
		if ( ! is_string( $json ) || strlen( $json ) > AEO_Store::MAX_JSON ) {
			return new WP_Error( 'aeo_bad_jsonld', 'The structured data is too large or could not be read.', array( 'status' => 400 ) );
		}
		$context = isset( $jsonld['@context'] ) ? $jsonld['@context'] : '';
		if ( ! is_string( $context ) || ! preg_match( '#^https?://schema\.org/?$#i', $context ) ) {
			return new WP_Error( 'aeo_bad_jsonld', 'The @context must be schema.org.', array( 'status' => 400 ) );
		}
		if ( ! AEO_Store::set_schema( $url, $json ) ) {
			return new WP_Error( 'aeo_full', 'Too many pages have structured data.', array( 'status' => 400 ) );
		}
		return rest_ensure_response( array( 'saved' => true ) );
	}

	public static function delete_schema( $request ) {
		$url = self::url_param( $request );
		if ( is_wp_error( $url ) ) {
			return $url;
		}
		return rest_ensure_response( array( 'removed' => AEO_Store::remove_schema( $url ) ) );
	}

	public static function put_meta( $request ) {
		$url = self::url_param( $request );
		if ( is_wp_error( $url ) ) {
			return $url;
		}
		$params      = $request->get_json_params();
		$title       = isset( $params['title'] ) && is_string( $params['title'] ) ? sanitize_text_field( $params['title'] ) : '';
		$description = isset( $params['description'] ) && is_string( $params['description'] ) ? sanitize_text_field( $params['description'] ) : '';
		if ( strlen( $title ) > 300 || strlen( $description ) > 500 ) {
			return new WP_Error( 'aeo_too_long', 'The title or description is too long.', array( 'status' => 400 ) );
		}
		if ( ! AEO_Store::set_meta( $url, $title, $description ) ) {
			return new WP_Error( 'aeo_full', 'Too many pages have their own title.', array( 'status' => 400 ) );
		}
		return rest_ensure_response( array( 'saved' => true ) );
	}

	public static function resolve( $request ) {
		$url = self::url_param( $request );
		if ( is_wp_error( $url ) ) {
			return $url;
		}
		$id = url_to_postid( $url );
		if ( ! $id ) {
			return rest_ensure_response( array( 'found' => false ) );
		}
		return rest_ensure_response(
			array(
				'found' => true,
				'id'    => $id,
				'type'  => get_post_type( $id ),
				'link'  => get_permalink( $id ),
			)
		);
	}

	public static function indexnow( $request ) {
		$key = (string) get_option( 'aeo_corner_indexnow', '' );
		if ( '' === $key ) {
			return new WP_Error( 'aeo_no_key', 'IndexNow is not set up.', array( 'status' => 400 ) );
		}
		$params = $request->get_json_params();
		$urls   = array();
		if ( is_array( $params ) && isset( $params['urls'] ) && is_array( $params['urls'] ) ) {
			foreach ( array_slice( $params['urls'], 0, 100 ) as $candidate ) {
				if ( is_string( $candidate ) && preg_match( '#^https?://#i', $candidate ) && AEO_Store::is_own( $candidate ) ) {
					$urls[] = esc_url_raw( $candidate );
				}
			}
		}
		if ( empty( $urls ) ) {
			return rest_ensure_response( array( 'pinged' => 0 ) );
		}
		$host     = wp_parse_url( home_url(), PHP_URL_HOST );
		$response = wp_remote_post(
			'https://api.indexnow.org/indexnow',
			array(
				'timeout' => 10,
				'headers' => array( 'Content-Type' => 'application/json; charset=utf-8' ),
				'body'    => wp_json_encode(
					array(
						'host'        => $host,
						'key'         => $key,
						'keyLocation' => home_url( '/' . $key . '.txt' ),
						'urlList'     => $urls,
					)
				),
			)
		);
		if ( is_wp_error( $response ) ) {
			return new WP_Error( 'aeo_indexnow_failed', 'IndexNow could not be reached.', array( 'status' => 502 ) );
		}
		$code = (int) wp_remote_retrieve_response_code( $response );
		if ( $code < 200 || $code >= 300 ) {
			return new WP_Error( 'aeo_indexnow_failed', 'IndexNow did not accept the request.', array( 'status' => 502 ) );
		}
		return rest_ensure_response( array( 'pinged' => count( $urls ) ) );
	}

	public static function disconnect() {
		AEO_Store::wipe();
		return rest_ensure_response( array( 'disconnected' => true ) );
	}
}
