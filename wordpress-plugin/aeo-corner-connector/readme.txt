=== AEO Corner Connector ===
Contributors: aeocorner
Tags: schema, json-ld, structured data, seo, indexnow
Requires at least: 6.2
Tested up to: 7.1
Requires PHP: 7.4
Stable tag: 1.1.0
License: GPLv2 or later
License URI: https://www.gnu.org/licenses/gpl-2.0.html

Connects your site to AEO Corner so structured data and page titles are added on the server, where search and AI crawlers can read them.

== Description ==

AEO Corner shows how often AI answer engines mention your business and helps you fix the gaps. Most AI crawlers do not run JavaScript, so structured data added by a script or a tag manager is invisible to them. This plugin lets your AEO Corner account add it on the server instead.

What it does:

* Prints the JSON-LD that you approved in AEO Corner in the head of the page it belongs to.
* Changes a page's title and description (through Yoast SEO or Rank Math when one of them is active).
* Adds Allow lines for the AI answer crawlers to the end of the robots.txt that WordPress builds, when you approved them. If your site has a real robots.txt file, nothing is added.
* Hosts your IndexNow key and tells IndexNow about a page you published or changed.
* Lets you disconnect with one click (Settings, AEO Corner). Disconnecting erases everything AEO Corner saved on your site.

How it is secured:

* Connecting needs an administrator: AEO Corner is given a one-time secret through an application password you create and can revoke.
* Every later request is signed with that secret (HMAC-SHA256), must be less than five minutes old, and can be used only once.
* It accepts a page address only if it belongs to this site.

External service: when AEO Corner asks, the plugin sends the addresses of pages you published or changed, your site's host name and your IndexNow key to api.indexnow.org (https://www.indexnow.org/documentation). It makes no other request of its own.

== Installation ==

1. Upload the plugin and activate it.
2. In AEO Corner, open your project, choose WordPress and follow the steps.

== Changelog ==

= 1.1.0 =
* New: Allow lines for answer crawlers in the robots.txt WordPress builds (only plain "User-agent / Allow: /" groups are accepted).
* New: the app can read what is saved for a page, so a change it made can be taken back exactly.
* A page whose saved title and description are both emptied goes back to the site's own.

= 1.0.0 =
* First release.
