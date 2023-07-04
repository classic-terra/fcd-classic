export const SLASHING_PERIOD = 10000
export const POST_TX_CHECK_LIMIT = 30
export const UTC_OFFSET_OF_SEOUL_IN_MIN = 540
export const TERRA_ACCOUNT_REGEX = /^terra1(?:[a-z0-9]{38}|[a-z0-9]{58})$/
export const TERRA_OPERATOR_ADD_REGEX = /^terravaloper1[a-z0-9]{38}$/
export const CHAIN_ID_REGEX = /^[a-zA-Z0-9-]{1,32}$/
export const MOVING_AVG_WINDOW_IN_DAYS = 10
export const DAYS_IN_YEAR = 365
export const ONE_DAY_IN_MS = 60000 * 60 * 24
export const LOCAL_TERRA_CHAIN_ID = 'localterra'
export const BOND_DENOM = 'uluna'
export const BURN_TAX_UPGRADE_HEIGHT = 9_346_889
// https://github.com/classic-terra/core/blob/952f56365dff51ce328caa7d766444369b7f3e0f/types/util/blocks.go#L8-L13
export const BLOCKS_PER_MINUTE = 10
export const BLOCKS_PER_HOUR = BLOCKS_PER_MINUTE * 60
export const BLOCKS_PER_DAY = BLOCKS_PER_HOUR * 24
export const BLOCKS_PER_WEEK = BLOCKS_PER_DAY * 7
export const BLOCKS_PER_MONTH = BLOCKS_PER_DAY * 30
export const BLOCKS_PER_YEAR = BLOCKS_PER_DAY * 365
