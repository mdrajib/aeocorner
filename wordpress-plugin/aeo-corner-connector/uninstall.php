<?php
/**
 * Deleting the plugin erases everything it saved.
 *
 * @package AEOCornerConnector
 */

if ( ! defined( 'WP_UNINSTALL_PLUGIN' ) ) {
	exit;
}

foreach ( array( 'aeo_corner_secret', 'aeo_corner_indexnow', 'aeo_corner_schema', 'aeo_corner_meta' ) as $aeo_option ) {
	delete_option( $aeo_option );
}
