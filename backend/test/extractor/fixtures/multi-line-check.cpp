#include <eosio/eosio.hpp>

namespace fixture {

void multi::open(const name& owner, const symbol& sym, const name& ram_payer)
{
    require_auth(ram_payer);
    check(
        is_account(owner)
            && sym.is_valid()
            && sym.precision() <= 18,
        "owner account does not exist or symbol invalid"
    );
}

}
