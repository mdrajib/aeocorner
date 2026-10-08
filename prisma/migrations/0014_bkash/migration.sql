-- bKash as a way to pay (ADR-0018). bKash has no subscription engine, so we keep the billing cycle ourselves:
-- a customer pays one month at a time through bKash's payment page, and each payment extends the period.
--
--   plans.price_bdt_month        the price in Bangladeshi taka (bKash takes BDT only). NULL = not open for bKash yet.
--   subscriptions.provider       who the money goes through. Stripe's reconcile only looks at 'stripe' rows. For a
--                                'bkash' row `stripe_subscription_id` holds our own key, 'bkash-<organization public id>'.
--   bkash_payments               one row per payment we ask bKash for, kept as the record of what was charged.

ALTER TABLE plans
  ADD COLUMN price_bdt_month DECIMAL(10,2) NULL COMMENT 'price in BDT for paying through bKash; NULL = not open yet';

ALTER TABLE subscriptions
  ADD COLUMN provider ENUM('stripe','bkash') NOT NULL DEFAULT 'stripe' COMMENT 'who the money goes through';

CREATE TABLE bkash_payments (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  public_id         CHAR(26)      NOT NULL,
  org_id            BIGINT UNSIGNED NOT NULL,
  plan_code         VARCHAR(32)   NOT NULL,
  purpose           ENUM('start','renewal','change') NOT NULL,
  amount_bdt        DECIMAL(10,2) NOT NULL,
  invoice_number    VARCHAR(40)   NOT NULL COMMENT 'merchantInvoiceNumber sent to bKash',
  bkash_payment_id  VARCHAR(64)   NULL COMMENT 'paymentID bKash returned when the payment was created',
  trx_id            VARCHAR(32)   NULL COMMENT 'bKash transaction ID once the payment completed',
  status            ENUM('created','completed','failed','cancelled','expired') NOT NULL DEFAULT 'created',
  failure_reason    VARCHAR(160)  NULL,
  period_start      DATETIME(3)   NULL COMMENT 'the period this payment bought, set when it completed',
  period_end        DATETIME(3)   NULL,
  applied_at        DATETIME(3)   NULL COMMENT 'when the subscription was updated from this payment; NULL on a completed one = retry',
  completed_at      DATETIME(3)   NULL,
  created_at        DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at        DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_bkash_payments_public (public_id),
  UNIQUE KEY uq_bkash_payments_invoice (invoice_number),
  UNIQUE KEY uq_bkash_payments_bkash (bkash_payment_id),
  UNIQUE KEY uq_bkash_payments_trx (trx_id),
  KEY ix_bkash_payments_org (org_id, created_at),
  KEY ix_bkash_payments_status (status, created_at),
  CONSTRAINT fk_bkash_payments_org  FOREIGN KEY (org_id)    REFERENCES organizations (id),
  CONSTRAINT fk_bkash_payments_plan FOREIGN KEY (plan_code) REFERENCES plans (code),
  CONSTRAINT ck_bkash_payments_amount CHECK (amount_bdt >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='Payments asked of bKash (ADR-0018)';
