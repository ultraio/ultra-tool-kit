#include "assertion-check.hpp"

namespace fixture {

void asserter::issue(const name& issuer, const asset& quantity)
{
    require_auth(issuer);
    ASSERTION_CHECK(quantity.amount > 0, ERR_NEGATIVE_AMOUNT);
    ASSERTION_CHECK(quantity.symbol.is_valid(), ERR_BAD_SYMBOL);
}

}
